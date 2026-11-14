//! fuse-wallet: the onchain lock of Fuse (v2).
//!
//! An AI agent's NEAR account holds exactly one key: a function-call key generated on an ESP32 and
//! scoped by the protocol to this contract and four methods (`pay`, `record_refusal`,
//! `request_chain_sig`, `approve_payment`). This contract is the third lock: it re-checks the chip's
//! policy, counts daily spend, records the chip's signed refusal receipts, forwards cross-chain
//! signing requests to the NEAR Chain Signatures (MPC) contract, and (v2) pins the firmware hash,
//! holds large payments for a second approver and shares refusal evidence with fuse-registry.
//!
//! Compatibility: a v1 chip calls `pay` without `fw` and `record_refusal` without `receiver`/`version`;
//! both keep working. The new checks are off until the owner sets them.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const EVENT_STANDARD: &str = "fuse";
const EVENT_VERSION: &str = "2.0.0";
const REFUSAL_DOMAIN_V1: &[u8] = b"FUSE_REFUSAL_V1";
const REFUSAL_DOMAIN_V2: &[u8] = b"FUSE_REFUSAL_V2";
const NANOS_PER_DAY: u64 = 86_400_000_000_000;
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(30);
const PAY_CALLBACK_GAS: Gas = Gas::from_tgas(10);
// The agent's tx carries at most 300 Tgas; leave room for this contract's own work and the callback.
const CHAIN_SIG_GAS: Gas = Gas::from_tgas(200);
const CHAIN_SIG_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Fire-and-forget `report` on fuse-registry. The bridge must attach >= 50 Tgas to `record_refusal`.
const REGISTRY_REPORT_GAS: Gas = Gas::from_tgas(20);
/// Refusal codes that say something about the counterparty and are shared with the registry:
/// RECEIVER_NOT_ALLOWED, TOKEN_NOT_ALLOWED, CHAIN_DEST_NOT_ALLOWED. Cap, timeout and structural
/// refusals are about this wallet, not the receiver, and stay local.
const COUNTERPARTY_CODES: [u8; 3] = [13, 14, 19];
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
    Pending,
    /// v2 refusal records written by `migrate()` (the v1 vector has a different element layout).
    RefusalsV2,
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
    /// `pending`, `submitted`, `ok`, `failed` or `cancelled`.
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
    /// v2: the `pay` receiver bound into the receipt digest (None for v1 receipts or non-pay refusals).
    pub receiver: Option<AccountId>,
    /// Receipt version the signature verified against (1 or 2).
    pub version: Option<u8>,
}

/// v1 layout of `RefusalRecord`, read by `migrate()`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct RefusalRecordV1 {
    pub id: u64,
    pub tx_hash_hex: String,
    pub code: u8,
    pub counter: u32,
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
pub struct Config {
    pub allowed_fw: Vec<String>,
    pub approvers: Vec<AccountId>,
    pub quorum_threshold: U128,
    pub registry: Option<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Counts {
    pub payments: u64,
    pub refusals: u64,
    pub chain_sigs: u64,
    pub pending: u64,
}

/// v1 contract state, read once by `migrate()`. Field order is the v1 borsh layout.
#[near(serializers = [borsh])]
pub struct FuseWalletV1 {
    owner: AccountId,
    agent: AccountId,
    chip_pubkey: Vec<u8>,
    paused: bool,
    policy: Policy,
    daily: LookupMap<u64, u128>,
    payments: Vector<PaymentRecord>,
    refusals: Vector<RefusalRecordV1>,
    chain_sigs: LookupMap<u64, ChainSigResult>,
    next_chain_sig_id: u64,
    chain_sig_contract: AccountId,
    chain_sig_deposit: u128,
    last_refusal_counter: u32,
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
    // ---- v2
    /// Lowercase hex sha256 of firmware images allowed to sign `pay`/`request_chain_sig`. Empty = off.
    allowed_fw: Vec<String>,
    /// Accounts that may call `approve_payment`.
    approvers: Vec<AccountId>,
    /// Payments strictly above this amount wait for an approver. 0 = off.
    quorum_threshold: u128,
    /// Payments waiting for approval, by id (also present in `payments` with status `pending`).
    pending: IterableMap<u64, PaymentRecord>,
    /// fuse-registry account that receives a `report` for every bound refusal.
    registry: Option<AccountId>,
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

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The exact bytes a v1 chip signs when it refuses a transaction.
pub fn refusal_digest(tx_hash: &[u8; 32], code: u8, counter: u32) -> [u8; 32] {
    let mut msg = Vec::with_capacity(REFUSAL_DOMAIN_V1.len() + 32 + 1 + 4);
    msg.extend_from_slice(REFUSAL_DOMAIN_V1);
    msg.extend_from_slice(tx_hash);
    msg.push(code);
    msg.extend_from_slice(&counter.to_le_bytes());
    env::sha256_array(&msg)
}

/// v2 receipt digest: sha256("FUSE_REFUSAL_V2" || tx_hash || code || counter_le || receiver_hash),
/// receiver_hash = sha256(receiver utf8) for a refused `pay`, 32 zero bytes otherwise.
pub fn refusal_digest_v2(
    tx_hash: &[u8; 32],
    code: u8,
    counter: u32,
    receiver: Option<&AccountId>,
) -> [u8; 32] {
    let receiver_hash = receiver
        .map(|r| env::sha256_array(r.as_bytes()))
        .unwrap_or([0u8; 32]);
    let mut msg = Vec::with_capacity(REFUSAL_DOMAIN_V2.len() + 32 + 1 + 4 + 32);
    msg.extend_from_slice(REFUSAL_DOMAIN_V2);
    msg.extend_from_slice(tx_hash);
    msg.push(code);
    msg.extend_from_slice(&counter.to_le_bytes());
    msg.extend_from_slice(&receiver_hash);
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
            allowed_fw: Vec::new(),
            approvers: Vec::new(),
            quorum_threshold: 0,
            pending: IterableMap::new(StorageKey::Pending),
            registry: None,
        }
    }

    /// Upgrade from v1 state: same fields, new ones default to "off". v1 refusal records are copied
    /// into a v2 vector (their borsh layout gained two optional fields) and the old vector is cleared.
    /// Deploy with `with-init-call migrate json-args {}`.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: FuseWalletV1 =
            env::state_read().unwrap_or_else(|| env::panic_str("migrate: no v1 state found"));
        let FuseWalletV1 {
            owner,
            agent,
            chip_pubkey,
            paused,
            policy,
            daily,
            payments,
            refusals: mut old_refusals,
            chain_sigs,
            next_chain_sig_id,
            chain_sig_contract,
            chain_sig_deposit,
            last_refusal_counter,
        } = old;
        let mut refusals: Vector<RefusalRecord> = Vector::new(StorageKey::RefusalsV2);
        for r in old_refusals.iter() {
            refusals.push(RefusalRecord {
                id: r.id,
                tx_hash_hex: r.tx_hash_hex.clone(),
                code: r.code,
                counter: r.counter,
                receipt_sig_b64: r.receipt_sig_b64.clone(),
                timestamp_ns: r.timestamp_ns,
                block_height: r.block_height,
                receiver: None,
                version: Some(1),
            });
        }
        old_refusals.clear();
        emit("migrate", json!({ "from": "1.0.0", "refusals": refusals.len() }));
        Self {
            owner,
            agent,
            chip_pubkey,
            paused,
            policy,
            daily,
            payments,
            refusals,
            chain_sigs,
            next_chain_sig_id,
            chain_sig_contract,
            chain_sig_deposit,
            last_refusal_counter,
            allowed_fw: Vec::new(),
            approvers: Vec::new(),
            quorum_threshold: 0,
            pending: IterableMap::new(StorageKey::Pending),
            registry: None,
        }
    }

    // ------------------------------------------------------------------ agent methods

    /// Pay `amount` of `token` to `receiver`. Callable only by the agent account, which holds only
    /// the chip's function-call key, so every call here was signed by the chip. `fw` is the firmware
    /// hash the chip put into the args (v1 chips omit it); checked only when `allowed_fw` is set.
    /// Above `quorum_threshold` the payment is recorded as `pending` and returns `false` until an
    /// approver calls `approve_payment`.
    pub fn pay(
        &mut self,
        receiver: AccountId,
        token: AccountId,
        amount: U128,
        memo: Option<String>,
        fw: Option<String>,
    ) -> PromiseOrValue<bool> {
        self.assert_agent();
        self.assert_not_paused();
        require!(
            env::attached_deposit().is_zero(),
            "pay: deposits are not accepted (function-call keys cannot attach them anyway)"
        );
        require!(self.fw_allowed(fw.as_deref()), "pay: firmware not allowed");
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

        let needs_quorum = self.quorum_threshold > 0 && amt > self.quorum_threshold;
        let id = self.payments.len() as u64;
        let record = PaymentRecord {
            id,
            receiver: receiver.clone(),
            token: token.clone(),
            amount,
            memo: memo.clone(),
            timestamp_ns: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
            status: if needs_quorum { "pending" } else { "submitted" }.to_string(),
        };
        self.payments.push(record.clone());
        if needs_quorum {
            // Counted against today's budget already; the transfer waits for an approver.
            self.pending.insert(id, record);
            emit(
                "pay_pending",
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
            return PromiseOrValue::Value(false);
        }
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
        PromiseOrValue::Promise(self.transfer_with_callback(&record, day))
    }

    /// Release a `pending` payment. The caller must be in `approvers` (an approver's own chip signs
    /// this through its agent account). The transfer runs with the usual callback.
    pub fn approve_payment(&mut self, id: u64) -> Promise {
        self.assert_not_paused();
        let by = env::predecessor_account_id();
        require!(
            self.approvers.contains(&by),
            "approve_payment: caller is not an approver"
        );
        let record = self
            .pending
            .remove(&id)
            .unwrap_or_else(|| env::panic_str("approve_payment: no pending payment with this id"));
        if let Some(rec) = self.payments.get_mut(id as u32) {
            rec.status = "submitted".to_string();
        }
        // Refund on failure goes to the day the payment was counted against, not today.
        let day = day_index(record.timestamp_ns.0);
        emit("pay_approved", json!({ "id": id, "by": by }));
        self.transfer_with_callback(&record, day)
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
            // The transfer did not happen: give the amount back to that day's budget.
            let spent = self.daily.get(&day).copied().unwrap_or(0);
            self.daily.insert(day, spent.saturating_sub(amount.0));
        }
        emit("pay_result", json!({ "id": id, "ok": ok }));
        ok
    }

    /// Record a refusal receipt signed by the chip. `tx_hash` is the hash of the NEAR transaction
    /// the chip refused (hex or base58), `receipt_sig` is base64 of `ed25519_sign(seed, digest)`.
    /// v1 (no `receiver`, `version` absent or 1): digest = sha256("FUSE_REFUSAL_V1" || hash || code || counter_le).
    /// v2 (`version` 2 or `receiver` present): `refusal_digest_v2`, which binds the refused receiver.
    /// Bound refusals with a counterparty code (13, 14, 19) are forwarded to the registry (if set).
    pub fn record_refusal(
        &mut self,
        tx_hash: String,
        code: u8,
        counter: u32,
        receipt_sig: String,
        receiver: Option<AccountId>,
        version: Option<u8>,
    ) {
        self.assert_agent();
        self.assert_not_paused();
        require!(
            counter > self.last_refusal_counter,
            "record_refusal: counter must increase (replay?)"
        );
        require!(
            matches!(version, None | Some(1) | Some(2)),
            "record_refusal: unsupported receipt version"
        );
        let version: u8 = if version == Some(2) || receiver.is_some() { 2 } else { 1 };
        let hash = parse_32(&tx_hash, "tx_hash");
        let sig = parse_sig64(&receipt_sig);
        let pk: [u8; 32] = self
            .chip_pubkey
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("chip pubkey corrupt"));
        let digest = if version == 2 {
            refusal_digest_v2(&hash, code, counter, receiver.as_ref())
        } else {
            refusal_digest(&hash, code, counter)
        };
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
            receipt_sig_b64: receipt_sig.clone(),
            timestamp_ns: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
            receiver: receiver.clone(),
            version: Some(version),
        });
        emit(
            "refusal",
            json!({ "id": id, "tx_hash": tx_hash_hex, "code": code, "counter": counter, "receiver": receiver, "version": version }),
        );

        // Share the evidence. The registry indexes by receiver, so only bound (v2) refusals with a
        // counterparty code are reported. Dropping the Promise schedules it; its outcome never
        // affects this call.
        if let (Some(registry), Some(recv), true) =
            (&self.registry, &receiver, COUNTERPARTY_CODES.contains(&code))
        {
            let args = json!({
                "chip_pubkey": hex::encode(&self.chip_pubkey),
                "receiver": recv,
                "tx_hash": tx_hash_hex,
                "code": code,
                "counter": counter,
                "receipt_sig": receipt_sig,
                "version": version,
            })
            .to_string()
            .into_bytes();
            let _ = Promise::new(registry.clone()).function_call(
                "report".to_string(),
                args,
                NearToken::from_yoctonear(0),
                REGISTRY_REPORT_GAS,
            );
        }
    }

    /// Ask the Chain Signatures MPC contract to sign `payload` for the derived account `path`.
    /// `payload` is base64: 32 bytes for domain 0 (secp256k1 / ECDSA, the hash to sign) or the
    /// message bytes for domain 1 (ed25519). `chain`, `to` and `value` are checked against the
    /// policy. The contract does not yet RLP-decode EVM payloads to cross-check `to`/`value`;
    /// that is a follow-up (see README). `fw` follows the same rule as in `pay`.
    #[payable]
    pub fn request_chain_sig(
        &mut self,
        path: String,
        payload: String,
        domain_id: u32,
        chain: String,
        to: String,
        value: U128,
        fw: Option<String>,
    ) -> Promise {
        self.assert_agent();
        self.assert_not_paused();
        require!(
            self.fw_allowed(fw.as_deref()),
            "request_chain_sig: firmware not allowed"
        );
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

    /// Firmware hashes (hex sha256 as printed by `hello.fw_sha256`) allowed to sign. Empty list = off.
    pub fn set_allowed_fw(&mut self, allowed_fw: Vec<String>) {
        self.assert_owner();
        require!(allowed_fw.len() <= 32, "set_allowed_fw: too many entries");
        let mut norm = Vec::with_capacity(allowed_fw.len());
        for f in &allowed_fw {
            let l = f.trim().to_lowercase();
            require!(is_sha256_hex(&l), "set_allowed_fw: entries must be 64 hex chars");
            if !norm.contains(&l) {
                norm.push(l);
            }
        }
        self.allowed_fw = norm;
        emit("config_update", json!({ "field": "allowed_fw", "value": self.allowed_fw }));
    }

    pub fn set_approvers(&mut self, approvers: Vec<AccountId>) {
        self.assert_owner();
        require!(approvers.len() <= 32, "set_approvers: too many entries");
        self.approvers = approvers;
        emit("config_update", json!({ "field": "approvers", "value": self.approvers }));
    }

    /// Payments strictly above this amount (atomic units) wait for `approve_payment`. 0 = off.
    pub fn set_quorum_threshold(&mut self, quorum_threshold: U128) {
        self.assert_owner();
        self.quorum_threshold = quorum_threshold.0;
        emit("config_update", json!({ "field": "quorum_threshold", "value": quorum_threshold }));
    }

    pub fn set_registry(&mut self, registry: Option<AccountId>) {
        self.assert_owner();
        self.registry = registry;
        emit("config_update", json!({ "field": "registry", "value": self.registry }));
    }

    /// Owner escape hatch for a payment the approvers will not release. Refunds that day's budget.
    pub fn cancel_pending(&mut self, id: u64) {
        self.assert_owner();
        let record = self
            .pending
            .remove(&id)
            .unwrap_or_else(|| env::panic_str("cancel_pending: no pending payment with this id"));
        let day = day_index(record.timestamp_ns.0);
        let spent = self.daily.get(&day).copied().unwrap_or(0);
        self.daily.insert(day, spent.saturating_sub(record.amount.0));
        if let Some(rec) = self.payments.get_mut(id as u32) {
            rec.status = "cancelled".to_string();
        }
        emit("pay_cancelled", json!({ "id": id, "by": env::predecessor_account_id() }));
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

    pub fn get_config(&self) -> Config {
        Config {
            allowed_fw: self.allowed_fw.clone(),
            approvers: self.approvers.clone(),
            quorum_threshold: U128(self.quorum_threshold),
            registry: self.registry.clone(),
        }
    }

    pub fn get_payments(&self, from_index: u64, limit: u64) -> Vec<PaymentRecord> {
        let end = from_index.saturating_add(limit).min(self.payments.len() as u64);
        (from_index..end)
            .filter_map(|i| self.payments.get(i as u32).cloned())
            .collect()
    }

    /// Payments waiting for approval, in the order they were created.
    pub fn get_pending(&self, from: u64, limit: u64) -> Vec<PaymentRecord> {
        self.pending
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|(_, v)| v.clone())
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
            pending: self.pending.len() as u64,
        }
    }

    /// Exposes the v1 refusal digest so the bridge and firmware tests can check their encoding.
    pub fn compute_refusal_digest(&self, tx_hash: String, code: u8, counter: u32) -> String {
        hex::encode(refusal_digest(&parse_32(&tx_hash, "tx_hash"), code, counter))
    }

    /// Same for the v2 digest. `receiver` None = 32 zero bytes for the receiver hash.
    pub fn compute_refusal_digest_v2(
        &self,
        tx_hash: String,
        code: u8,
        counter: u32,
        receiver: Option<AccountId>,
    ) -> String {
        hex::encode(refusal_digest_v2(
            &parse_32(&tx_hash, "tx_hash"),
            code,
            counter,
            receiver.as_ref(),
        ))
    }

    // ------------------------------------------------------------------ internals

    fn transfer_with_callback(&self, rec: &PaymentRecord, day: u64) -> Promise {
        let transfer = if rec.token.as_str() == NATIVE_TOKEN {
            Promise::new(rec.receiver.clone()).transfer(NearToken::from_yoctonear(rec.amount.0))
        } else {
            Promise::new(rec.token.clone()).function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": rec.receiver, "amount": rec.amount, "memo": rec.memo })
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                FT_TRANSFER_GAS,
            )
        };
        transfer.then(
            Self::ext(env::current_account_id())
                .with_static_gas(PAY_CALLBACK_GAS)
                .on_pay_result(rec.id, rec.amount, day),
        )
    }

    fn fw_allowed(&self, fw: Option<&str>) -> bool {
        if self.allowed_fw.is_empty() {
            return true;
        }
        match fw {
            Some(f) => self.allowed_fw.contains(&f.trim().to_lowercase()),
            None => false,
        }
    }

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
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
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
    fn approver() -> AccountId {
        acc("approver.testnet")
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
    const FW: &str = "a3f1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    fn pay(c: &mut FuseWallet, r: &str, t: &str, a: u128) -> PromiseOrValue<bool> {
        c.pay(acc(r), acc(t), U128(a), None, None)
    }
    fn is_value_false(p: &PromiseOrValue<bool>) -> bool {
        matches!(p, PromiseOrValue::Value(false))
    }

    #[test]
    fn pay_allowed_records_and_counts() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 5).build());
        let p = c.pay(acc("api.testnet"), acc("usdc.testnet"), U128(3), Some("m".into()), None);
        assert!(matches!(p, PromiseOrValue::Promise(_)));
        assert_eq!(c.get_daily_spent().0, 3);
        let recs = c.get_payments(0, 10);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].status, "submitted");
        assert_eq!(recs[0].receiver, acc("api.testnet"));
        let logs = get_logs();
        assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:")
            && l.contains("\"event\":\"pay\"")
            && l.contains("\"version\":\"2.0.0\"")));
        let _p2 = pay(&mut c, "data.testnet", "near", 2);
        assert_eq!(c.get_daily_spent().0, 5);
        assert_eq!(c.get_counts().payments, 2);
        assert_eq!(c.get_counts().pending, 0);
    }

    #[test]
    #[should_panic(expected = "only the agent account may call this method")]
    fn pay_rejects_non_agent() {
        let mut c = new_contract();
        testing_env!(ctx(&acc("mallory.testnet"), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 1);
    }

    #[test]
    #[should_panic(expected = "only the agent account may call this method")]
    fn pay_rejects_owner_too() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 1);
    }

    #[test]
    #[should_panic(expected = "pay: receiver not in allowlist")]
    fn pay_rejects_unlisted_receiver() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "attacker.testnet", "near", 1);
    }

    #[test]
    #[should_panic(expected = "pay: token not in allowlist")]
    fn pay_rejects_unlisted_token() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "shady.testnet", 1);
    }

    #[test]
    #[should_panic(expected = "pay: amount over per-tx cap")]
    fn pay_rejects_over_per_tx_cap() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 6);
    }

    #[test]
    #[should_panic(expected = "pay: daily cap exceeded")]
    fn pay_rejects_over_daily_cap_across_calls() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 10).build());
        let _ = pay(&mut c, "api.testnet", "near", 5);
        let _ = pay(&mut c, "api.testnet", "near", 5);
        assert_eq!(c.get_daily_spent().0, 10);
        // third one crosses 12
        let _ = pay(&mut c, "api.testnet", "near", 3);
    }

    #[test]
    fn daily_cap_resets_next_day() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 10).build());
        let _ = pay(&mut c, "api.testnet", "near", 5);
        let _ = pay(&mut c, "api.testnet", "near", 5);
        testing_env!(ctx(&agent(), 2 * DAY + 10).build());
        assert_eq!(c.get_daily_spent().0, 0);
        let _ = pay(&mut c, "api.testnet", "near", 5);
        assert_eq!(c.get_daily_spent().0, 5);
    }

    #[test]
    fn failed_transfer_refunds_daily_budget() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY + 10).build());
        let _ = pay(&mut c, "api.testnet", "usdc.testnet", 4);
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
        let _ = pay(&mut c, "api.testnet", "near", 1);
    }

    // ---------------------------------------------------------------- v2: firmware allowlist

    #[test]
    fn pay_fw_allowlist_off_accepts_any_fw() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(1), None, Some("deadbeef".into()));
        let _ = pay(&mut c, "api.testnet", "near", 1);
        assert_eq!(c.get_counts().payments, 2);
    }

    #[test]
    fn pay_fw_allowlist_accepts_listed_fw_case_insensitive() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        c.set_allowed_fw(vec![FW.to_uppercase()]);
        assert_eq!(c.get_config().allowed_fw, vec![FW.to_string()]);
        testing_env!(ctx(&agent(), DAY).build());
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(1), None, Some(FW.into()));
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(1), None, Some(FW.to_uppercase()));
        assert_eq!(c.get_counts().payments, 2);
    }

    #[test]
    #[should_panic(expected = "pay: firmware not allowed")]
    fn pay_fw_allowlist_rejects_missing_fw() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        c.set_allowed_fw(vec![FW.into()]);
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 1);
    }

    #[test]
    #[should_panic(expected = "pay: firmware not allowed")]
    fn pay_fw_allowlist_rejects_unknown_fw() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        c.set_allowed_fw(vec![FW.into()]);
        testing_env!(ctx(&agent(), DAY).build());
        let other = FW.replace('a', "b");
        let _ = c.pay(acc("api.testnet"), acc("near"), U128(1), None, Some(other));
    }

    #[test]
    #[should_panic(expected = "request_chain_sig: firmware not allowed")]
    fn request_chain_sig_fw_allowlist_rejects_missing_fw() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        c.set_allowed_fw(vec![FW.into()]);
        testing_env!(ctx(&agent(), DAY).attached_deposit(NearToken::from_yoctonear(1)).build());
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        let _ = c.request_chain_sig("ethereum-1".into(), payload, 0, "eth-sepolia".into(), "0xabc".into(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "set_allowed_fw: entries must be 64 hex chars")]
    fn set_allowed_fw_validates_hex() {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        c.set_allowed_fw(vec!["not-a-hash".into()]);
    }

    // ---------------------------------------------------------------- v2: quorum

    fn quorum_contract() -> FuseWallet {
        let mut c = new_contract();
        testing_env!(ctx(&owner(), DAY).build());
        c.set_approvers(vec![approver()]);
        c.set_quorum_threshold(U128(3));
        assert_eq!(c.get_config().quorum_threshold.0, 3);
        assert_eq!(c.get_config().approvers, vec![approver()]);
        c
    }

    #[test]
    fn quorum_small_payment_goes_through() {
        let mut c = quorum_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let p = pay(&mut c, "api.testnet", "near", 3);
        assert!(matches!(p, PromiseOrValue::Promise(_)));
        assert_eq!(c.get_counts().pending, 0);
    }

    #[test]
    fn quorum_large_payment_pends_then_approves() {
        let mut c = quorum_contract();
        testing_env!(ctx(&agent(), DAY + 7).build());
        let p = pay(&mut c, "api.testnet", "near", 4);
        assert!(is_value_false(&p));
        assert!(get_created_receipts().is_empty(), "no transfer before approval");
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"pay_pending\"")));
        // counted against the daily cap at once
        assert_eq!(c.get_daily_spent().0, 4);
        assert_eq!(c.get_payments(0, 1)[0].status, "pending");
        let pend = c.get_pending(0, 10);
        assert_eq!(pend.len(), 1);
        assert_eq!(pend[0].id, 0);
        assert_eq!(c.get_counts().pending, 1);

        testing_env!(ctx(&approver(), DAY + 9).build());
        drop(c.approve_payment(0)); // promises are constructed on drop
        let receipts = get_created_receipts();
        assert!(receipts.iter().any(|r| r.receiver_id == acc("api.testnet")), "transfer scheduled");
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"pay_approved\"") && l.contains("approver.testnet")));
        assert_eq!(c.get_payments(0, 1)[0].status, "submitted");
        assert!(c.get_pending(0, 10).is_empty());
        assert_eq!(c.get_counts().pending, 0);

        // the callback marks it ok and keeps the budget
        testing_env!(ctx(&acc("fuse.owner.testnet"), DAY + 10).build());
        assert!(c.on_pay_result(0, U128(4), day_index(DAY + 7), Ok(())));
        assert_eq!(c.get_payments(0, 1)[0].status, "ok");
        assert_eq!(c.get_daily_spent().0, 4);
    }

    #[test]
    #[should_panic(expected = "approve_payment: caller is not an approver")]
    fn approve_rejects_non_approver() {
        let mut c = quorum_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 4);
        testing_env!(ctx(&owner(), DAY).build());
        let _ = c.approve_payment(0);
    }

    #[test]
    #[should_panic(expected = "approve_payment: no pending payment with this id")]
    fn approve_rejects_unknown_or_already_sent_id() {
        let mut c = quorum_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 1); // id 0, sent directly
        testing_env!(ctx(&approver(), DAY).build());
        let _ = c.approve_payment(0);
    }

    #[test]
    fn cancel_pending_refunds_daily_budget() {
        let mut c = quorum_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 4);
        let _ = pay(&mut c, "api.testnet", "near", 5);
        assert_eq!(c.get_daily_spent().0, 9);
        assert_eq!(c.get_pending(0, 10).len(), 2);
        assert_eq!(c.get_pending(1, 10).len(), 1);
        testing_env!(ctx(&owner(), DAY + 1).build());
        c.cancel_pending(0);
        assert_eq!(c.get_daily_spent().0, 5);
        assert_eq!(c.get_payments(0, 1)[0].status, "cancelled");
        assert_eq!(c.get_pending(0, 10).len(), 1);
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"pay_cancelled\"")));
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn cancel_pending_owner_only() {
        let mut c = quorum_contract();
        testing_env!(ctx(&agent(), DAY).build());
        let _ = pay(&mut c, "api.testnet", "near", 4);
        testing_env!(ctx(&approver(), DAY).build());
        c.cancel_pending(0);
    }

    // ---------------------------------------------------------------- refusals

    fn sign_refusal(hash: &[u8; 32], code: u8, counter: u32) -> String {
        use base64::Engine as _;
        let digest = refusal_digest(hash, code, counter);
        let sig = chip().sign(&digest);
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }

    fn sign_refusal_v2(hash: &[u8; 32], code: u8, counter: u32, receiver: Option<&AccountId>) -> String {
        use base64::Engine as _;
        let digest = refusal_digest_v2(hash, code, counter, receiver);
        let sig = chip().sign(&digest);
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }

    #[test]
    fn record_refusal_accepts_valid_receipt() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 13, 1, sig, None, None);
        let r = c.get_refusals(0, 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].code, 13);
        assert_eq!(r[0].counter, 1);
        assert_eq!(r[0].tx_hash_hex, hex::encode(hash));
        assert_eq!(r[0].receiver, None);
        assert_eq!(r[0].version, Some(1));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"refusal\"")));
        // base58 input works too, and the counter must increase
        let sig2 = sign_refusal(&hash, 2, 2);
        c.record_refusal(bs58::encode(hash).into_string(), 2, 2, sig2, None, Some(1));
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
        c.record_refusal(hex::encode(hash), 13, 1, b64, None, None);
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn record_refusal_rejects_tampered_code() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 14, 1, sig, None, None);
    }

    #[test]
    #[should_panic(expected = "counter must increase")]
    fn record_refusal_rejects_replay() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 13, 1, sig.clone(), None, None);
        c.record_refusal(hex::encode(hash), 13, 1, sig, None, None);
    }

    #[test]
    fn record_refusal_v2_binds_receiver() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        let attacker = acc("attacker.testnet");
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal_v2(&hash, 13, 1, Some(&attacker));
        c.record_refusal(hex::encode(hash), 13, 1, sig, Some(attacker.clone()), Some(2));
        // version inferred from the receiver when absent
        let sig2 = sign_refusal_v2(&hash, 13, 2, Some(&attacker));
        c.record_refusal(hex::encode(hash), 13, 2, sig2, Some(attacker.clone()), None);
        // v2 receipt without a receiver (non-pay refusal): zero receiver hash
        let sig3 = sign_refusal_v2(&hash, 17, 3, None);
        c.record_refusal(hex::encode(hash), 17, 3, sig3, None, Some(2));
        let r = c.get_refusals(0, 10);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].receiver, Some(attacker.clone()));
        assert_eq!(r[0].version, Some(2));
        assert_eq!(r[1].version, Some(2));
        assert_eq!(r[2].receiver, None);
        assert_eq!(r[2].version, Some(2));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"refusal\"") && l.contains("attacker.testnet")));
        // no registry set: nothing scheduled
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn record_refusal_v2_rejects_swapped_receiver() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal_v2(&hash, 13, 1, Some(&acc("attacker.testnet")));
        c.record_refusal(hex::encode(hash), 13, 1, sig, Some(acc("innocent.testnet")), Some(2));
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn record_refusal_v1_receipt_rejected_as_v2() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 13, 1, sig, None, Some(2));
    }

    #[test]
    #[should_panic(expected = "unsupported receipt version")]
    fn record_refusal_rejects_unknown_version() {
        let mut c = new_contract();
        let hash = [7u8; 32];
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal(&hash, 13, 1);
        c.record_refusal(hex::encode(hash), 13, 1, sig, None, Some(3));
    }

    #[test]
    fn record_refusal_v2_reports_to_registry() {
        let mut c = new_contract();
        let registry = acc("registry.owner.testnet");
        testing_env!(ctx(&owner(), DAY).build());
        c.set_registry(Some(registry.clone()));
        assert_eq!(c.get_config().registry, Some(registry.clone()));
        let hash = [7u8; 32];
        let attacker = acc("attacker.testnet");
        testing_env!(ctx(&agent(), DAY).build());
        let sig = sign_refusal_v2(&hash, 13, 1, Some(&attacker));
        c.record_refusal(hex::encode(hash), 13, 1, sig.clone(), Some(attacker.clone()), Some(2));
        let receipts = get_created_receipts();
        let rep = receipts
            .iter()
            .find(|r| r.receiver_id == registry)
            .expect("report receipt scheduled on the registry");
        let call = rep
            .actions
            .iter()
            .find_map(|a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, prepaid_gas, .. } => {
                    Some((method_name.clone(), args.clone(), *prepaid_gas))
                }
                _ => None,
            })
            .expect("function call action");
        assert_eq!(call.0, b"report".to_vec());
        assert_eq!(call.2, REGISTRY_REPORT_GAS);
        let args: serde_json::Value = serde_json::from_slice(&call.1).unwrap();
        assert_eq!(args["chip_pubkey"], hex::encode(chip().verifying_key().to_bytes()));
        assert_eq!(args["receiver"], "attacker.testnet");
        assert_eq!(args["tx_hash"], hex::encode(hash));
        assert_eq!(args["code"], 13);
        assert_eq!(args["counter"], 1);
        assert_eq!(args["receipt_sig"], sig);
        assert_eq!(args["version"], 2);

        // a v1 receipt (no receiver) is stored but not reported: the registry indexes by receiver
        testing_env!(ctx(&agent(), DAY + 1).build());
        c.record_refusal(hex::encode(hash), 13, 2, sign_refusal(&hash, 13, 2), None, None);
        assert!(get_created_receipts().is_empty());
        assert_eq!(c.get_counts().refusals, 2);

        // TOKEN_NOT_ALLOWED and CHAIN_DEST_NOT_ALLOWED are counterparty codes too
        for (code, counter) in [(14u8, 3u32), (19, 4)] {
            testing_env!(ctx(&agent(), DAY + 2).build());
            let s = sign_refusal_v2(&hash, code, counter, Some(&attacker));
            c.record_refusal(hex::encode(hash), code, counter, s, Some(attacker.clone()), Some(2));
            assert!(get_created_receipts().iter().any(|r| r.receiver_id == registry), "code {code} reported");
        }
    }

    #[test]
    fn record_refusal_v2_keeps_wallet_local_codes_out_of_registry() {
        // AMOUNT_OVER_CAP (15), VELOCITY_CAP (16), BUTTON_TIMEOUT (17), NONCE_REPLAY (11) say nothing
        // about the receiver: stored locally, never reported, even with a bound receipt and a registry.
        let mut c = new_contract();
        let registry = acc("registry.owner.testnet");
        testing_env!(ctx(&owner(), DAY).build());
        c.set_registry(Some(registry.clone()));
        let hash = [7u8; 32];
        let seller = acc("api.testnet");
        for (i, code) in [15u8, 16, 17, 11].iter().enumerate() {
            let counter = i as u32 + 1;
            testing_env!(ctx(&agent(), DAY + counter as u64).build());
            let s = sign_refusal_v2(&hash, *code, counter, Some(&seller));
            c.record_refusal(hex::encode(hash), *code, counter, s, Some(seller.clone()), Some(2));
            assert!(get_created_receipts().is_empty(), "code {code} must not be reported");
        }
        assert_eq!(c.get_counts().refusals, 4);
        let r = c.get_refusals(0, 10);
        assert_eq!(r[0].code, 15);
        assert_eq!(r[0].receiver, Some(seller));
    }

    // ---------------------------------------------------------------- owner config

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
    fn config_setters_emit_and_default_off() {
        let mut c = new_contract();
        let cfg = c.get_config();
        assert!(cfg.allowed_fw.is_empty() && cfg.approvers.is_empty());
        assert_eq!(cfg.quorum_threshold.0, 0);
        assert_eq!(cfg.registry, None);
        testing_env!(ctx(&owner(), DAY).build());
        c.set_allowed_fw(vec![FW.into(), FW.into()]);
        c.set_approvers(vec![approver(), owner()]);
        c.set_quorum_threshold(U128(10));
        c.set_registry(Some(acc("registry.testnet")));
        let cfg = c.get_config();
        assert_eq!(cfg.allowed_fw.len(), 1, "deduplicated");
        assert_eq!(cfg.approvers.len(), 2);
        assert_eq!(cfg.quorum_threshold.0, 10);
        assert_eq!(cfg.registry, Some(acc("registry.testnet")));
        let logs = get_logs();
        for f in ["allowed_fw", "approvers", "quorum_threshold", "registry"] {
            assert!(logs.iter().any(|l| l.contains("\"event\":\"config_update\"") && l.contains(f)), "{f}");
        }
        c.set_registry(None);
        assert_eq!(c.get_config().registry, None);
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn set_approvers_rejects_agent() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        c.set_approvers(vec![agent()]);
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn set_registry_rejects_approver() {
        let mut c = new_contract();
        testing_env!(ctx(&approver(), DAY).build());
        c.set_registry(None);
    }

    // ---------------------------------------------------------------- chain sig

    #[test]
    fn request_chain_sig_checks_policy_and_records() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).attached_deposit(NearToken::from_yoctonear(1)).build());
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        let _p = c.request_chain_sig("ethereum-1".into(), payload, 0, "eth-sepolia".into(), "0xABC".into(), U128(500), None);
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
        let _ = c.request_chain_sig("ethereum-1".into(), payload, 0, "eth-sepolia".into(), "0xdead".into(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "value over cap")]
    fn request_chain_sig_rejects_over_cap() {
        let mut c = new_contract();
        testing_env!(ctx(&agent(), DAY).build());
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);
        let _ = c.request_chain_sig("ethereum-1".into(), payload, 0, "eth-sepolia".into(), "0xabc".into(), U128(5_000), None);
    }

    // ---------------------------------------------------------------- digests

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

    #[test]
    fn refusal_digest_v2_matches_spec() {
        // sha256("FUSE_REFUSAL_V2" || hash || code || counter_le || sha256(receiver)) with sha2
        use sha2::Digest;
        let hash = [3u8; 32];
        let receiver = acc("attacker.testnet");
        let rh = sha2::Sha256::digest(b"attacker.testnet");
        let mut m = Vec::new();
        m.extend_from_slice(b"FUSE_REFUSAL_V2");
        m.extend_from_slice(&hash);
        m.push(13);
        m.extend_from_slice(&5u32.to_le_bytes());
        m.extend_from_slice(&rh);
        let expected = sha2::Sha256::digest(&m);
        testing_env!(ctx(&owner(), 1).build());
        assert_eq!(refusal_digest_v2(&hash, 13, 5, Some(&receiver)).to_vec(), expected.to_vec());
        let c = new_contract();
        assert_eq!(
            c.compute_refusal_digest_v2(hex::encode(hash), 13, 5, Some(receiver.clone())),
            hex::encode(expected)
        );
        // no receiver: 32 zero bytes
        let mut m0 = Vec::new();
        m0.extend_from_slice(b"FUSE_REFUSAL_V2");
        m0.extend_from_slice(&hash);
        m0.push(13);
        m0.extend_from_slice(&5u32.to_le_bytes());
        m0.extend_from_slice(&[0u8; 32]);
        let expected0 = sha2::Sha256::digest(&m0);
        assert_eq!(c.compute_refusal_digest_v2(hex::encode(hash), 13, 5, None), hex::encode(expected0));
        assert_ne!(expected, expected0);
        // and v1 differs from v2 for the same inputs
        assert_ne!(c.compute_refusal_digest(hex::encode(hash), 13, 5), hex::encode(expected0));
    }

    #[test]
    fn refusal_digest_v2_bridge_vector() {
        // Shared test vector with the bridge (bridge/src tests): tx_hash = 0x01..0x20, code 13, counter 7,
        // receiver "attacker.testnet"; and the same with no receiver (32 zero bytes).
        let hash: [u8; 32] = core::array::from_fn(|i| (i + 1) as u8);
        testing_env!(ctx(&owner(), 1).build());
        let c = new_contract();
        assert_eq!(
            c.compute_refusal_digest_v2(hex::encode(hash), 13, 7, Some(acc("attacker.testnet"))),
            "3091912debd71ecc48be63e3b950242d42d9f9312bf742ab25a0cfb4b972eae3"
        );
        assert_eq!(
            c.compute_refusal_digest_v2(hex::encode(hash), 13, 7, None),
            "0fcda75ba09d9b7c9279548dc9a5b6691a2b311457f98b0534e1e2f0a3e2ef9e"
        );
        // base58 tx_hash gives the same digest
        assert_eq!(
            c.compute_refusal_digest_v2(bs58::encode(hash).into_string(), 13, 7, Some(acc("attacker.testnet"))),
            "3091912debd71ecc48be63e3b950242d42d9f9312bf742ab25a0cfb4b972eae3"
        );
    }

    // ---------------------------------------------------------------- migrate

    #[test]
    fn migrate_from_v1_state() {
        // Build v1 state the way the v1 contract would have written it: same storage keys, a payment, two refusals.
        testing_env!(ctx(&owner(), 1).build());
        let mut v1 = FuseWalletV1 {
            owner: owner(),
            agent: agent(),
            chip_pubkey: chip().verifying_key().to_bytes().to_vec(),
            paused: false,
            policy: policy(),
            daily: LookupMap::new(StorageKey::Daily),
            payments: Vector::new(StorageKey::Payments),
            refusals: Vector::new(StorageKey::Refusals),
            chain_sigs: LookupMap::new(StorageKey::ChainSigs),
            next_chain_sig_id: 3,
            chain_sig_contract: acc("v1.signer-prod.testnet"),
            chain_sig_deposit: 1,
            last_refusal_counter: 2,
        };
        v1.daily.insert(1, 5);
        v1.payments.push(PaymentRecord {
            id: 0,
            receiver: acc("api.testnet"),
            token: acc("near"),
            amount: U128(5),
            memo: Some("v1".into()),
            timestamp_ns: U64(DAY),
            block_height: U64(10),
            status: "ok".into(),
        });
        for (i, counter) in [1u32, 2].iter().enumerate() {
            v1.refusals.push(RefusalRecordV1 {
                id: i as u64,
                tx_hash_hex: hex::encode([i as u8; 32]),
                code: 13,
                counter: *counter,
                receipt_sig_b64: "AAAA".into(),
                timestamp_ns: U64(DAY + i as u64),
                block_height: U64(11 + i as u64),
            });
        }
        env::state_write(&v1); // flushes the collections and writes the v1 struct under STATE
        drop(v1);

        testing_env!(ctx(&acc("fuse.owner.testnet"), DAY).build());
        let c = FuseWallet::migrate();
        assert_eq!(c.get_state().owner, owner());
        assert_eq!(c.get_state().agent, agent());
        assert_eq!(c.get_state().last_refusal_counter, 2);
        assert_eq!(c.get_state().chip_pubkey_hex, hex::encode(chip().verifying_key().to_bytes()));
        assert_eq!(c.get_policy().per_tx_cap.0, 5);
        let cfg = c.get_config();
        assert!(cfg.allowed_fw.is_empty() && cfg.approvers.is_empty());
        assert_eq!(cfg.quorum_threshold.0, 0);
        assert_eq!(cfg.registry, None);
        let counts = c.get_counts();
        assert_eq!((counts.payments, counts.refusals, counts.chain_sigs, counts.pending), (1, 2, 3, 0));
        assert_eq!(c.get_payments(0, 10)[0].memo, Some("v1".into()));
        let r = c.get_refusals(0, 10);
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].counter, 2);
        assert_eq!(r[1].receiver, None);
        assert_eq!(r[1].version, Some(1));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"migrate\"")));
        // the migrated contract keeps working: daily counter for day 1 survived, new refusals append
        let mut c = c;
        testing_env!(ctx(&agent(), DAY + 100).build());
        assert_eq!(c.get_daily_spent().0, 5);
        let hash = [9u8; 32];
        c.record_refusal(hex::encode(hash), 13, 3, sign_refusal(&hash, 13, 3), None, None);
        assert_eq!(c.get_counts().refusals, 3);
        assert_eq!(c.get_refusals(2, 1)[0].counter, 3);
    }

    #[test]
    #[should_panic(expected = "migrate: no v1 state found")]
    fn migrate_requires_v1_state() {
        testing_env!(ctx(&acc("fuse.owner.testnet"), DAY).build());
        let _ = FuseWallet::migrate();
    }
}
