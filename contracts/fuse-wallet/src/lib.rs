//! fuse-wallet: the onchain lock of Fuse.
//!
//! An AI agent's NEAR account holds exactly one key: a function-call key generated on an ESP32 and
//! scoped by the protocol to this contract and three methods (`pay`, `record_refusal`,
//! `request_chain_sig`). This contract is the third lock: it re-checks the chip's policy, counts
//! daily spend, records the chip's signed refusal receipts, and forwards cross-chain signing requests
//! to the NEAR Chain Signatures (MPC) contract.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const EVENT_STANDARD: &str = "fuse";
const EVENT_VERSION: &str = "1.0.0";
const REFUSAL_DOMAIN: &[u8] = b"FUSE_REFUSAL_V1";
const NANOS_PER_DAY: u64 = 86_400_000_000_000;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
const PAY_CALLBACK_GAS: Gas = Gas::from_tgas(10);
// The agent's tx carries at most 300 Tgas; leave room for this contract's own work and the callback.
const CHAIN_SIG_GAS: Gas = Gas::from_tgas(200);
const CHAIN_SIG_CALLBACK_GAS: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Pseudo-token id meaning native NEAR.
const NATIVE_TOKEN: &str = "near";

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Daily,
    Payments,
    Refusals,
    ChainSigs,
}

/// A permitted cross-chain destination. `chain` is a free-form id ("eth-sepolia", "btc-testnet4"),
/// `to` is the destination address in that chain's canonical lowercase form.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainDest {
    pub chain: String,
    pub to: String,
}

/// The onchain policy. Mirrors the chip's policy; the contract is authoritative for the daily cap.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Policy {
    pub receiver_allowlist: Vec<AccountId>,
    /// Token contract ids the agent may spend. The literal `near` means native NEAR.
    pub token_allowlist: Vec<AccountId>,
    pub per_tx_cap: U128,
    pub daily_cap: U128,
    pub chain_dest_allowlist: Vec<ChainDest>,
    pub chain_value_cap: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PaymentRecord {
    pub id: u64,
    pub receiver: AccountId,
    pub token: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    pub timestamp_ns: U64,
    pub block_height: U64,
    /// `submitted`, `ok` or `failed`.
    pub status: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RefusalRecord {
    pub id: u64,
    /// Hex of the 32-byte NEAR transaction hash the chip refused to sign.
    pub tx_hash_hex: String,
    pub code: u8,
    pub counter: u32,
    /// Base64 of the chip's 64-byte ed25519 receipt signature.
    pub receipt_sig_b64: String,
    pub timestamp_ns: U64,
    pub block_height: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ChainSigResult {
    pub id: u64,
    pub path: String,
    pub chain: String,
    pub to: String,
    pub value: U128,
    pub domain_id: u32,
    pub payload_hex: String,
    /// `pending`, `ok` or `failed`.
    pub status: String,
    /// Raw JSON returned by the MPC contract (kept opaque to stay agnostic to its exact shape).
    pub result_json: Option<String>,
    pub timestamp_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StateView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub chip_pubkey_hex: String,
    pub chip_pubkey_b58: String,
    pub paused: bool,
    pub chain_sig_contract: AccountId,
    pub chain_sig_deposit: U128,
    pub last_refusal_counter: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Counts {
    pub payments: u64,
    pub refusals: u64,
    pub chain_sigs: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FuseWallet {
    owner: AccountId,
    agent: AccountId,
    chip_pubkey: Vec<u8>,
    paused: bool,
    policy: Policy,
    /// day index (block_timestamp / 1 day) -> total spent that day, in the token's atomic units
    /// summed across tokens (per-token daily caps are a follow-up; the cap is deliberately coarse).
    daily: LookupMap<u64, u128>,
    payments: Vector<PaymentRecord>,
    refusals: Vector<RefusalRecord>,
    chain_sigs: LookupMap<u64, ChainSigResult>,
    next_chain_sig_id: u64,
    chain_sig_contract: AccountId,
    chain_sig_deposit: u128,
    last_refusal_counter: u32,
}

fn emit(event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

fn day_index(timestamp_ns: u64) -> u64 {
    timestamp_ns / NANOS_PER_DAY
}

/// Accepts a 32-byte value as 64 hex chars or base58 (with or without an `ed25519:` prefix).
fn parse_32(input: &str, what: &str) -> [u8; 32] {
    let s = input.strip_prefix("ed25519:").unwrap_or(input);
    let bytes: Vec<u8> = if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        hex::decode(s).unwrap_or_default()
    } else {
        bs58::decode(s).into_vec().unwrap_or_default()
    };
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .unwrap_or_else(|_| env::panic_str(&format!("{what}: expected 32 bytes as hex or base58")));
    arr
}

fn parse_sig64(input: &str) -> [u8; 64] {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input)
        .unwrap_or_else(|_| env::panic_str("receipt_sig: invalid base64"));
    bytes
        .as_slice()
        .try_into()
        .unwrap_or_else(|_| env::panic_str("receipt_sig: expected 64 bytes"))
}

fn parse_b64(input: &str, what: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .unwrap_or_else(|_| env::panic_str(&format!("{what}: invalid base64")))
}

/// The exact bytes the chip signs when it refuses a transaction.
pub fn refusal_digest(tx_hash: &[u8; 32], code: u8, counter: u32) -> [u8; 32] {
    let mut msg = Vec::with_capacity(REFUSAL_DOMAIN.len() + 32 + 1 + 4);
    msg.extend_from_slice(REFUSAL_DOMAIN);
    msg.extend_from_slice(tx_hash);
    msg.push(code);
    msg.extend_from_slice(&counter.to_le_bytes());
    env::sha256_array(&msg)
}

#[near]
impl FuseWallet {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, chip_pubkey: String, policy: Policy) -> Self {
        let pk = parse_32(&chip_pubkey, "chip_pubkey");
        Self::validate_policy(&policy);
        Self {
            owner,
            agent,
            chip_pubkey: pk.to_vec(),
            paused: false,
            policy,
            daily: LookupMap::new(StorageKey::Daily),
            payments: Vector::new(StorageKey::Payments),
            refusals: Vector::new(StorageKey::Refusals),
            chain_sigs: LookupMap::new(StorageKey::ChainSigs),
            next_chain_sig_id: 0,
            chain_sig_contract: "v1.signer-prod.testnet"
                .parse()
                .unwrap_or_else(|_| env::panic_str("bad default chain sig contract")),
            chain_sig_deposit: 1,
            last_refusal_counter: 0,
        }
    }

    // ------------------------------------------------------------------ agent methods

    /// Pay `amount` of `token` to `receiver`. Callable only by the agent account, which holds only
    /// the chip's function-call key, so every call here was signed by the chip.
    pub fn pay(
        &mut self,
        receiver: AccountId,
        token: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        self.assert_agent();
        self.assert_not_paused();
        require!(
            env::attached_deposit().is_zero(),
            "pay: deposits are not accepted (function-call keys cannot attach them anyway)"
        );
        let amt = amount.0;
        require!(amt > 0, "pay: amount must be positive");
        require!(
            self.policy.receiver_allowlist.contains(&receiver),
            "pay: receiver not in allowlist"
        );
        require!(
            self.policy.token_allowlist.contains(&token),
            "pay: token not in allowlist"
        );
        require!(amt <= self.policy.per_tx_cap.0, "pay: amount over per-tx cap");
        if let Some(m) = &memo {
            require!(m.len() <= 256, "pay: memo too long");
        }

        let day = day_index(env::block_timestamp());
        let spent = self.daily.get(&day).copied().unwrap_or(0);
        let new_total = spent
            .checked_add(amt)
            .unwrap_or_else(|| env::panic_str("pay: overflow"));
        require!(new_total <= self.policy.daily_cap.0, "pay: daily cap exceeded");
        self.daily.insert(day, new_total);

        let id = self.payments.len() as u64;
        let record = PaymentRecord {
            id,
            receiver: receiver.clone(),
            token: token.clone(),
            amount,
            memo: memo.clone(),
            timestamp_ns: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
            status: "submitted".to_string(),
        };
        self.payments.push(record);
        emit(
            "pay",
            json!({
                "id": id,
                "receiver": receiver,
                "token": token,
                "amount": amount,
                "memo": memo,
                "day": day,
                "daily_total": U128(new_total),
            }),
        );

        let transfer = if token.as_str() == NATIVE_TOKEN {
            Promise::new(receiver).transfer(NearToken::from_yoctonear(amt))
        } else {
            Promise::new(token).function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": receiver, "amount": amount, "memo": memo })
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                FT_TRANSFER_GAS,
            )
        };
        transfer.then(
            Self::ext(env::current_account_id())
                .with_static_gas(PAY_CALLBACK_GAS)
                .on_pay_result(id, amount, day),
        )
    }

    #[private]
    pub fn on_pay_result(
        &mut self,
        id: u64,
        amount: U128,
        day: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let ok = result.is_ok();
        if let Some(rec) = self.payments.get_mut(id as u32) {
            rec.status = if ok { "ok" } else { "failed" }.to_string();
        }
        if !ok {
            // The transfer did not happen: give the amount back to today's budget.
            let spent = self.daily.get(&day).copied().unwrap_or(0);
            self.daily.insert(day, spent.saturating_sub(amount.0));
        }
        emit("pay_result", json!({ "id": id, "ok": ok }));
        ok
    }

    /// Record a refusal receipt signed by the chip. `tx_hash` is the hash of the NEAR transaction
    /// the chip refused (hex or base58), `receipt_sig` is base64 of
    /// `ed25519_sign(seed, sha256("FUSE_REFUSAL_V1" || tx_hash || code || counter_le))`.
    pub fn record_refusal(&mut self, tx_hash: String, code: u8, counter: u32, receipt_sig: String) {
        self.assert_agent();
        self.assert_not_paused();
        require!(
            counter > self.last_refusal_counter,
            "record_refusal: counter must increase (replay?)"
        );
        let hash = parse_32(&tx_hash, "tx_hash");
        let sig = parse_sig64(&receipt_sig);
        let pk: [u8; 32] = self
            .chip_pubkey
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("chip pubkey corrupt"));
        let digest = refusal_digest(&hash, code, counter);
        require!(
            env::ed25519_verify(&sig, &digest, &pk),
            "record_refusal: receipt signature does not verify against the chip key"
        );
        self.last_refusal_counter = counter;

        let id = self.refusals.len() as u64;
        let tx_hash_hex = hex::encode(hash);
        self.refusals.push(RefusalRecord {
            id,
            tx_hash_hex: tx_hash_hex.clone(),
            code,
            counter,
            receipt_sig_b64: receipt_sig,
            timestamp_ns: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
        });
        emit(
            "refusal",
            json!({ "id": id, "tx_hash": tx_hash_hex, "code": code, "counter": counter }),
        );
    }

    /// Ask the Chain Signatures MPC contract to sign `payload` for the derived account `path`.
    /// `payload` is base64: 32 bytes for domain 0 (secp256k1 / ECDSA, the hash to sign) or the
    /// message bytes for domain 1 (ed25519). `chain`, `to` and `value` are checked against the
    /// policy. The contract does not yet RLP-decode EVM payloads to cross-check `to`/`value`;
    /// that is a follow-up (see README).
    #[payable]
    pub fn request_chain_sig(
        &mut self,
        path: String,
        payload: String,
        domain_id: u32,
        chain: String,
        to: String,
        value: U128,
    ) -> Promise {
        self.assert_agent();
        self.assert_not_paused();
        require!(!path.is_empty() && path.len() <= 128, "request_chain_sig: bad path");
        let dest = ChainDest {
            chain: chain.clone(),
            to: to.to_lowercase(),
        };
        require!(
            self.policy.chain_dest_allowlist.contains(&dest),
            "request_chain_sig: (chain, to) not in allowlist"
        );
        require!(
            value.0 <= self.policy.chain_value_cap.0,
            "request_chain_sig: value over cap"
        );
        let bytes = parse_b64(&payload, "payload");
        let variant = match domain_id {
            0 => {
                require!(bytes.len() == 32, "request_chain_sig: ECDSA payload must be 32 bytes");
                "Ecdsa"
            }
            1 => {
                require!(
                    !bytes.is_empty() && bytes.len() <= 1232,
                    "request_chain_sig: EdDSA payload size out of range"
                );
                "Eddsa"
            }
            _ => env::panic_str("request_chain_sig: domain_id must be 0 (ecdsa) or 1 (eddsa)"),
        };
        let payload_hex = hex::encode(&bytes);

        let id = self.next_chain_sig_id;
        self.next_chain_sig_id += 1;
        self.chain_sigs.insert(
            id,
            ChainSigResult {
                id,
                path: path.clone(),
                chain: chain.clone(),
                to: dest.to.clone(),
                value,
                domain_id,
                payload_hex: payload_hex.clone(),
                status: "pending".to_string(),
                result_json: None,
                timestamp_ns: U64(env::block_timestamp()),
            },
        );
        emit(
            "chain_sig_request",
            json!({ "id": id, "path": path, "chain": chain, "to": dest.to, "value": value, "domain_id": domain_id }),
        );

        // Wire format of the MPC contract `sign` method (verified live on v1.signer-prod.testnet, 2026-11-13: the
        // contract answers "missing field `request`" without the wrapper):
        // { "request": { "path": String, "payload_v2": { "Ecdsa" | "Eddsa": hex }, "domain_id": number } }
        let args = json!({
            "request": {
                "path": path,
                "payload_v2": { variant: payload_hex },
                "domain_id": domain_id,
            }
        })
        .to_string()
        .into_bytes();
        Promise::new(self.chain_sig_contract.clone())
            .function_call(
                "sign".to_string(),
                args,
                NearToken::from_yoctonear(self.chain_sig_deposit),
                CHAIN_SIG_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CHAIN_SIG_CALLBACK_GAS)
                    .on_chain_sig(id),
            )
    }

    #[private]
    pub fn on_chain_sig(
        &mut self,
        id: u64,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let (status, result_json) = match result {
            Ok(v) => ("ok", Some(v.to_string())),
            Err(_) => ("failed", None),
        };
        if let Some(rec) = self.chain_sigs.get_mut(&id) {
            rec.status = status.to_string();
            rec.result_json = result_json;
        }
        emit("chain_sig", json!({ "id": id, "status": status }));
        PromiseOrValue::Value(status == "ok")
    }

    // ------------------------------------------------------------------ owner methods

    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        Self::validate_policy(&policy);
        self.policy = policy;
        emit("policy_update", json!({ "by": env::predecessor_account_id() }));
    }

    pub fn set_chip_key(&mut self, chip_pubkey: String) {
        self.assert_owner();
        let pk = parse_32(&chip_pubkey, "chip_pubkey");
        self.chip_pubkey = pk.to_vec();
        self.last_refusal_counter = 0;
        emit("chip_key_update", json!({ "chip_pubkey_hex": hex::encode(pk) }));
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agent = agent.clone();
        emit("agent_update", json!({ "agent": agent }));
    }

    pub fn set_chain_sig_contract(&mut self, account: AccountId, deposit: U128) {
        self.assert_owner();
        self.chain_sig_contract = account;
        self.chain_sig_deposit = deposit.0;
    }

    pub fn withdraw(&mut self, token: AccountId, amount: U128, to: AccountId) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "withdraw: amount must be positive");
        if token.as_str() == NATIVE_TOKEN {
            Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
        } else {
            Promise::new(token).function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": to, "amount": amount, "memo": "fuse withdraw" })
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                FT_TRANSFER_GAS,
            )
        }
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("pause", json!({ "paused": true }));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("pause", json!({ "paused": false }));
    }

    // ------------------------------------------------------------------ views

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_state(&self) -> StateView {
        StateView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            chip_pubkey_hex: hex::encode(&self.chip_pubkey),
            chip_pubkey_b58: format!("ed25519:{}", bs58::encode(&self.chip_pubkey).into_string()),
            paused: self.paused,
            chain_sig_contract: self.chain_sig_contract.clone(),
            chain_sig_deposit: U128(self.chain_sig_deposit),
            last_refusal_counter: self.last_refusal_counter,
        }
    }

    pub fn get_payments(&self, from_index: u64, limit: u64) -> Vec<PaymentRecord> {
        let end = from_index.saturating_add(limit).min(self.payments.len() as u64);
        (from_index..end)
            .filter_map(|i| self.payments.get(i as u32).cloned())
            .collect()
    }

    pub fn get_refusals(&self, from_index: u64, limit: u64) -> Vec<RefusalRecord> {
        let end = from_index.saturating_add(limit).min(self.refusals.len() as u64);
        (from_index..end)
            .filter_map(|i| self.refusals.get(i as u32).cloned())
            .collect()
    }

    /// Amount spent today (UTC day of the current block), summed across tokens.
    pub fn get_daily_spent(&self) -> U128 {
        U128(
            self.daily
                .get(&day_index(env::block_timestamp()))
                .copied()
                .unwrap_or(0),
        )
    }

    pub fn get_chain_sig_result(&self, id: u64) -> Option<ChainSigResult> {
        self.chain_sigs.get(&id).cloned()
    }

    pub fn get_counts(&self) -> Counts {
        Counts {
            payments: self.payments.len() as u64,
            refusals: self.refusals.len() as u64,
            chain_sigs: self.next_chain_sig_id,
        }
    }

    /// Exposes the refusal digest so the bridge and firmware tests can check their encoding.
    pub fn compute_refusal_digest(&self, tx_hash: String, code: u8, counter: u32) -> String {
        hex::encode(refusal_digest(&parse_32(&tx_hash, "tx_hash"), code, counter))
    }

    // ------------------------------------------------------------------ internals

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may call this method"
        );
    }

    fn assert_agent(&self) {
        require!(
            env::predecessor_account_id() == self.agent,
            "only the agent account may call this method"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "wallet is paused by the owner");
    }

    fn validate_policy(policy: &Policy) {
        require!(policy.per_tx_cap.0 > 0, "policy: per_tx_cap must be positive");
        require!(
            policy.daily_cap.0 >= policy.per_tx_cap.0,
            "policy: daily_cap must be >= per_tx_cap"
        );
        require!(
            policy.receiver_allowlist.len() <= 256 && policy.token_allowlist.len() <= 64,
            "policy: allowlists too long"
        );
        require!(
            policy.chain_dest_allowlist.len() <= 256,
            "policy: chain_dest_allowlist too long"
        );
        for d in &policy.chain_dest_allowlist {
            require!(
                d.to == d.to.to_lowercase(),
                "policy: chain destination addresses must be lowercase"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn owner() -> AccountId {
        acc("owner.testnet")
    }
    fn agent() -> AccountId {
        acc("agent.owner.testnet")
    }
    fn chip() -> SigningKey {
        SigningKey::from_bytes(&[42u8; 32])
    }
    fn policy() -> Policy {
        Policy {
            receiver_allowlist: vec![acc("api.testnet"), acc("data.testnet")],
            token_allowlist: vec![acc("near"), acc("usdc.testnet")],
            per_tx_cap: U128(5),
            daily_cap: U128(12),
            chain_dest_allowlist: vec![ChainDest {
                chain: "eth-sepolia".into(),
                to: "0xabc".into(),
            }],
            chain_value_cap: U128(1_000),
        }
    }
    fn ctx(predecessor: &AccountId, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("fuse.owner.testnet"))
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor.clone())
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(0));
        b
    }
    fn new_contract() -> FuseWallet {
        testing_env!(ctx(&owner(), 1).build());
        FuseWallet::new(
            owner(),
            agent(),
            hex::encode(chip().verifying_key().to_bytes()),
            policy(),
        )
    }
    const DAY: u64 = NANOS_PER_DAY;

    #[test]
    fn pay_allowed_records_and_counts() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 5).build());
        let _p = c.pay(acc("api.testnet"), acc("usdc.testnet"), U128(3), Some("m".into()));
        assert_eq!(c.get_daily_spent().0, 3);
        let recs = c.get_payments(0, 10);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].status, "submitted");
        assert_eq!(recs[0].receiver, acc("api.testnet"));
        let logs = get_logs();
        assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"pay\"")));
        let _p2 = c.pay(acc("data.testnet"), acc("near"), U128(2), None);
        assert_eq!(c.get_daily_spent().0, 5);
        assert_eq!(c.get_counts().payments, 2);
    }

    #[test]
    #[should_panic(expected = "only the agent account may call this method")]
    fn pay_rejects_non_agent() {
        let mut c = new_contract();
        testing_env!(ctx(&acc("mallory.testnet"), DAY).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "only the agent account may call this method")]
    fn pay_rejects_owner_too() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "pay: receiver not in allowlist")]
    fn pay_rejects_unlisted_receiver() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = c.pay(acc("attacker.testnet"), acc("near"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "pay: token not in allowlist")]
    fn pay_rejects_unlisted_token() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = c.pay(acc("api.testnet"), acc("shady.testnet"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "pay: amount over per-tx cap")]
    fn pay_rejects_over_per_tx_cap() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(6), None);
    }

    #[test]
    #[should_panic(expected = "pay: daily cap exceeded")]
    fn pay_rejects_over_daily_cap_across_calls() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 10).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(5), None);
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(5), None);
        assert_eq!(c.get_daily_spent().0, 10);
        // third one crosses 12
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(3), None);
    }

    #[test]
    fn daily_cap_resets_next_day() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 10).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(5), None);
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(5), None);
        testing_env!(ctx(&agent(), 2 * DAY + 10).build());
        assert_eq!(c.get_daily_spent().0, 0);
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(5), None);
        assert_eq!(c.get_daily_spent().0, 5);
    }

    #[test]
    fn failed_transfer_refunds_daily_budget() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 10).build());
        let _ = c.pay(acc("api.testnet"), acc("usdc.testnet"), U128(4), None);
        assert_eq!(c.get_daily_spent().0, 4);
        testing_env!(ctx(&acc("fuse.owner.testnet"), DAY + 11).build());
        let ok = c.on_pay_result(0, U128(4), day_index(DAY + 10), Err(PromiseError::Failed));
        assert!(!ok);
        assert_eq!(c.get_daily_spent().0, 0);
        assert_eq!(c.get_payments(0, 1)[0].status, "failed");
    }

    #[test]
    #[should_panic(expected = "wallet is paused by the owner")]
    fn pay_rejects_when_paused() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        c.pause();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(1), None);
    }

    fn sign_refusal(hash: &[u8; 32], code: u8, counter: u32) -> String {
        use base64::Engine as _;
        let digest = refusal_digest(hash, code, counter);
        let sig = chip().sign(&digest);
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }

    #[test]
    fn record_refusal_accepts_valid_receipt() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 13, 1, sig);
        let r = c.get_refusals(0, 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].code, 13);
        assert_eq!(r[0].counter, 1);
        assert_eq!(r[0].tx_hash_hex, hex::encode(hash));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"refusal\"")));
        // base58 input works too, and the counter must increase
        let sig2 = sign_refusal(&hash, 2, 2);
        c.record_refusal(bs58::encode(hash).into_string(), 2, 2, sig2);
        assert_eq!(c.get_counts().refusals, 2);
        assert_eq!(c.get_state().last_refusal_counter, 2);
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn record_refusal_rejects_forged_receipt() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let forger = SigningKey::from_bytes(&[1u8; 32]);
        use base64::Engine as _;
        let sig = forger.sign(&refusal_digest(&hash, 13, 1));
        let b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        c.record_refusal(hex::encode(hash), 13, 1, b64);
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn record_refusal_rejects_tampered_code() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 14, 1, sig);
    }

    #[test]
    #[should_panic(expected = "counter must increase")]
    fn record_refusal_rejects_replay() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 13, 1, sig.clone());
        c.record_refusal(hex::encode(hash), 13, 1, sig);
    }

    #[test]
    fn set_policy_owner_only() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        let mut p = policy();
        p.per_tx_cap = U128(7);
        c.set_policy(p);
        assert_eq!(c.get_policy().per_tx_cap.0, 7);
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn set_policy_rejects_agent() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        c.set_policy(policy());
    }

    #[test]
    #[should_panic(expected = "policy: daily_cap must be >= per_tx_cap")]
    fn set_policy_validates() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        let mut p = policy();
        p.daily_cap = U128(1);
        c.set_policy(p);
    }

    #[test]
    fn request_chain_sig_checks_policy_and_records() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).attached_deposit(NearToken::from_yoctonear(1)).build());
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        let _p = c.request_chain_sig("ethereum-1".into(), payload, 0, "eth-sepolia".into(), "0xABC".into(), U128(500));
        let r = c.get_chain_sig_result(0).unwrap();
        assert_eq!(r.status, "pending");
        assert_eq!(r.to, "0xabc");
        assert_eq!(r.payload_hex, hex::encode([9u8; 32]));
        testing_env!(ctx(&acc("fuse.owner.testnet"), DAY).build());
        let _ = c.on_chain_sig(0, Ok(json!({"big_r": "x"})));
        let r = c.get_chain_sig_result(0).unwrap();
        assert_eq!(r.status, "ok");
        assert!(r.result_json.unwrap().contains("big_r"));
    }

    #[test]
    #[should_panic(expected = "(chain, to) not in allowlist")]
    fn request_chain_sig_rejects_unlisted_dest() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        let _ = c.request_chain_sig("ethereum-1".into(), payload, 0, "eth-sepolia".into(), "0xdead".into(), U128(1));
    }

    #[test]
    #[should_panic(expected = "value over cap")]
    fn request_chain_sig_rejects_over_cap() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        let _ = c.request_chain_sig("ethereum-1".into(), payload, 0, "eth-sepolia".into(), "0xabc".into(), U128(5_000));
    }

    #[test]
    fn refusal_digest_matches_spec() {
        // sha256("FUSE_REFUSAL_V1" || hash || code || counter_le) computed independently with sha2
        use sha2::Digest;
        let hash = [3u8; 32];
        let mut m = Vec::new();
        m.extend_from_slice(b"FUSE_REFUSAL_V1");
        m.extend_from_slice(&hash);
        m.push(9);
        m.extend_from_slice(&77u32.to_le_bytes());
        let expected = sha2::Sha256::digest(&m);
        testing_env!(ctx(&owner(), 1).build());
        assert_eq!(refusal_digest(&hash, 9, 77).to_vec(), expected.to_vec());
        let c = new_contract();
        assert_eq!(c.compute_refusal_digest(hex::encode(hash), 9, 77), hex::encode(expected));
    }
}
