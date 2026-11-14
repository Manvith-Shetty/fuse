//! fuse-registry: shared refusal evidence for Fuse wallets.
//!
//! A Fuse chip signs a receipt every time it refuses to pay. A fuse-wallet forwards bound (v2)
//! receipts here; anyone else may report one too. The registry verifies the receipt against the
//! chip key named in the report, indexes it by the refused receiver and answers `check(receiver)`
//! with `allow` / `warn` / `block`. The owner can curate: manual blocks and trusted reporters.
//!
//! The registry never trusts the reporter about the refusal itself: a report is accepted only when
//! `ed25519_verify(receipt_sig, digest, chip_pubkey)` holds. What the reporter can lie about is which
//! chip key is "a Fuse chip" (anyone can make a key and sign refusals about anyone): that is why
//! verdicts weigh distinct chips and trusted reporters, and why `block` needs more than one voice.

use std::collections::{BTreeMap, HashSet};

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

const EVENT_STANDARD: &str = "fuse-registry";
const EVENT_VERSION: &str = "1.0.0";
const REFUSAL_DOMAIN_V1: &[u8] = b"FUSE_REFUSAL_V1";
const REFUSAL_DOMAIN_V2: &[u8] = b"FUSE_REFUSAL_V2";
/// Refusal code `RECEIVER_NOT_ALLOWED` (firmware/lib/fusecore/codes.h, bridge/src/codes.ts).
pub const CODE_RECEIVER_NOT_ALLOWED: u8 = 13;
/// Codes a report may carry: 13 RECEIVER_NOT_ALLOWED, 14 TOKEN_NOT_ALLOWED, 19 CHAIN_DEST_NOT_ALLOWED.
/// Everything else (caps, timeouts, structure) is about the refusing wallet, not the counterparty.
pub const ALLOWED_CODES: [u8; 3] = [13, 14, 19];
const TOP_CODES: usize = 5;
const MAX_REPORTS_PER_RECEIVER: usize = 4096;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Reports,
    ByReceiver,
    Seen,
    Manual,
    Trusted,
    Reporters,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Report {
    pub id: u64,
    pub reporter: AccountId,
    pub chip_pubkey_hex: String,
    pub receiver: AccountId,
    pub code: u8,
    pub tx_hash_hex: String,
    pub counter: u32,
    /// true when the receipt (v2) binds the receiver; false for v1 receipts, where the receiver is
    /// the reporter's claim.
    pub bound: bool,
    pub version: u8,
    pub timestamp_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Verdict {
    /// `allow`, `warn` or `block`.
    pub verdict: String,
    pub reports: u32,
    pub distinct_reporters: u32,
    pub distinct_chips: u32,
    pub bound_reports: u32,
    /// Distinct chips among bound reports (the `block` rule counts these).
    pub bound_chips: u32,
    pub trusted_reports: u32,
    /// Bound reports weighted: trusted reporters count double.
    pub bound_weight: u32,
    pub last_ts: U64,
    pub manual: Option<String>,
    /// (code, count), most frequent first, at most 5.
    pub top_codes: Vec<(u8, u32)>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Stats {
    pub receivers: u64,
    pub reports: u64,
    pub reporters: u64,
    pub trusted: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct FuseRegistry {
    owner: AccountId,
    reports: Vector<Report>,
    /// receiver -> report ids, in report order.
    by_receiver: LookupMap<AccountId, Vec<u64>>,
    /// Replay guard: "<chip_pubkey_hex>:<counter>".
    seen: LookupSet<String>,
    /// Curated blocks: receiver -> reason.
    manual: LookupMap<AccountId, String>,
    trusted: IterableSet<AccountId>,
    reporters: LookupSet<AccountId>,
    receivers_count: u64,
    reporters_count: u64,
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

/// v1 receipt digest (fuse-wallet `refusal_digest`).
pub fn refusal_digest_v1(tx_hash: &[u8; 32], code: u8, counter: u32) -> [u8; 32] {
    let mut msg = Vec::with_capacity(REFUSAL_DOMAIN_V1.len() + 32 + 1 + 4);
    msg.extend_from_slice(REFUSAL_DOMAIN_V1);
    msg.extend_from_slice(tx_hash);
    msg.push(code);
    msg.extend_from_slice(&counter.to_le_bytes());
    env::sha256_array(&msg)
}

/// v2 receipt digest (fuse-wallet `refusal_digest_v2`): binds sha256(receiver).
pub fn refusal_digest_v2(tx_hash: &[u8; 32], code: u8, counter: u32, receiver: &AccountId) -> [u8; 32] {
    let receiver_hash = env::sha256_array(receiver.as_bytes());
    let mut msg = Vec::with_capacity(REFUSAL_DOMAIN_V2.len() + 32 + 1 + 4 + 32);
    msg.extend_from_slice(REFUSAL_DOMAIN_V2);
    msg.extend_from_slice(tx_hash);
    msg.push(code);
    msg.extend_from_slice(&counter.to_le_bytes());
    msg.extend_from_slice(&receiver_hash);
    env::sha256_array(&msg)
}

#[near]
impl FuseRegistry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            reports: Vector::new(StorageKey::Reports),
            by_receiver: LookupMap::new(StorageKey::ByReceiver),
            seen: LookupSet::new(StorageKey::Seen),
            manual: LookupMap::new(StorageKey::Manual),
            trusted: IterableSet::new(StorageKey::Trusted),
            reporters: LookupSet::new(StorageKey::Reporters),
            receivers_count: 0,
            reporters_count: 0,
        }
    }

    // ------------------------------------------------------------------ reporting (anyone)

    /// Report a chip-signed refusal of a payment to `receiver`. `version` 2: the receipt binds the
    /// receiver (`bound`). `version` 1: the receipt proves a refusal with this hash/code/counter but
    /// the receiver is the reporter's word (`unbound`). The storage is paid by the registry.
    pub fn report(
        &mut self,
        chip_pubkey: String,
        receiver: AccountId,
        tx_hash: String,
        code: u8,
        counter: u32,
        receipt_sig: String,
        version: u8,
    ) -> u64 {
        require!(
            ALLOWED_CODES.contains(&code),
            "report: code is not a counterparty code (13, 14, 19)"
        );
        let pk = parse_32(&chip_pubkey, "chip_pubkey");
        let hash = parse_32(&tx_hash, "tx_hash");
        let sig = parse_sig64(&receipt_sig);
        let (digest, bound) = match version {
            1 => (refusal_digest_v1(&hash, code, counter), false),
            2 => (refusal_digest_v2(&hash, code, counter, &receiver), true),
            _ => env::panic_str("report: unsupported receipt version"),
        };
        require!(
            env::ed25519_verify(&sig, &digest, &pk),
            "report: receipt signature does not verify against chip_pubkey"
        );
        let chip_pubkey_hex = hex::encode(pk);
        require!(
            self.seen.insert(format!("{chip_pubkey_hex}:{counter}")),
            "report: duplicate (chip, counter)"
        );

        let reporter = env::predecessor_account_id();
        if self.reporters.insert(reporter.clone()) {
            self.reporters_count += 1;
        }
        let id = self.reports.len() as u64;
        let mut ids = self.by_receiver.get(&receiver).cloned().unwrap_or_default();
        if ids.is_empty() {
            self.receivers_count += 1;
        }
        require!(
            ids.len() < MAX_REPORTS_PER_RECEIVER,
            "report: too many reports for this receiver"
        );
        ids.push(id);
        self.by_receiver.insert(receiver.clone(), ids);
        self.reports.push(Report {
            id,
            reporter: reporter.clone(),
            chip_pubkey_hex: chip_pubkey_hex.clone(),
            receiver: receiver.clone(),
            code,
            tx_hash_hex: hex::encode(hash),
            counter,
            bound,
            version,
            timestamp_ns: U64(env::block_timestamp()),
        });
        emit(
            "report",
            json!({
                "id": id,
                "receiver": receiver,
                "reporter": reporter,
                "chip_pubkey_hex": chip_pubkey_hex,
                "code": code,
                "counter": counter,
                "bound": bound,
                "trusted": self.trusted.contains(&reporter),
            }),
        );
        id
    }

    // ------------------------------------------------------------------ curation (owner)

    pub fn report_manual(&mut self, receiver: AccountId, reason: String) {
        self.assert_owner();
        require!(!reason.is_empty() && reason.len() <= 256, "report_manual: reason length");
        self.manual.insert(receiver.clone(), reason.clone());
        emit("manual", json!({ "receiver": receiver, "reason": reason }));
    }

    pub fn clear_manual(&mut self, receiver: AccountId) {
        self.assert_owner();
        require!(self.manual.remove(&receiver).is_some(), "clear_manual: no manual entry");
        emit("manual", json!({ "receiver": receiver, "reason": null }));
    }

    /// Drop every report about `receiver` from the index (mistaken or test reports). The records stay
    /// readable by id and the replay guard keeps its (chip, counter) entries, so the same receipts
    /// cannot be re-reported. Returns how many were dropped.
    pub fn clear_reports(&mut self, receiver: AccountId) -> u32 {
        self.assert_owner();
        let ids = self.by_receiver.remove(&receiver).unwrap_or_default();
        if !ids.is_empty() {
            self.receivers_count = self.receivers_count.saturating_sub(1);
        }
        emit("clear_reports", json!({ "receiver": receiver, "count": ids.len() }));
        ids.len() as u32
    }

    /// Trusted reporters' reports weigh double in `check`.
    pub fn trust(&mut self, reporter: AccountId) {
        self.assert_owner();
        require!(self.trusted.len() < 256, "trust: too many trusted reporters");
        self.trusted.insert(reporter.clone());
        emit("trust", json!({ "reporter": reporter, "trusted": true }));
    }

    pub fn untrust(&mut self, reporter: AccountId) {
        self.assert_owner();
        require!(self.trusted.remove(&reporter), "untrust: not trusted");
        emit("trust", json!({ "reporter": reporter, "trusted": false }));
    }

    // ------------------------------------------------------------------ views

    /// Verdict on paying `receiver`:
    /// block: manual entry, or >= 2 distinct chips among bound reports, or a trusted reporter
    ///        reported RECEIVER_NOT_ALLOWED, or bound weight >= 3 (trusted reporters count double);
    /// warn : any report; allow: none.
    pub fn check(&self, receiver: AccountId) -> Verdict {
        let manual = self.manual.get(&receiver).cloned();
        let ids = self.by_receiver.get(&receiver).cloned().unwrap_or_default();
        let mut reporters: HashSet<&AccountId> = HashSet::new();
        let mut chips: HashSet<&str> = HashSet::new();
        let mut bound_chips: HashSet<&str> = HashSet::new();
        let mut codes: BTreeMap<u8, u32> = BTreeMap::new();
        let (mut bound_reports, mut trusted_reports, mut bound_weight, mut trusted_rna) = (0u32, 0u32, 0u32, 0u32);
        let mut last_ts = 0u64;
        let reports: Vec<&Report> = ids.iter().filter_map(|i| self.reports.get(*i as u32)).collect();
        for r in &reports {
            reporters.insert(&r.reporter);
            chips.insert(r.chip_pubkey_hex.as_str());
            *codes.entry(r.code).or_insert(0) += 1;
            last_ts = last_ts.max(r.timestamp_ns.0);
            let trusted = self.trusted.contains(&r.reporter);
            let weight = if trusted { 2 } else { 1 };
            if trusted {
                trusted_reports += 1;
                if r.code == CODE_RECEIVER_NOT_ALLOWED {
                    trusted_rna += 1;
                }
            }
            if r.bound {
                bound_reports += 1;
                bound_weight += weight;
                bound_chips.insert(r.chip_pubkey_hex.as_str());
            }
        }
        let mut top_codes: Vec<(u8, u32)> = codes.into_iter().collect();
        top_codes.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        top_codes.truncate(TOP_CODES);
        let verdict = if manual.is_some() || bound_chips.len() >= 2 || trusted_rna >= 1 || bound_weight >= 3 {
            "block"
        } else if !reports.is_empty() {
            "warn"
        } else {
            "allow"
        };
        Verdict {
            verdict: verdict.to_string(),
            reports: reports.len() as u32,
            distinct_reporters: reporters.len() as u32,
            distinct_chips: chips.len() as u32,
            bound_reports,
            bound_chips: bound_chips.len() as u32,
            trusted_reports,
            bound_weight,
            last_ts: U64(last_ts),
            manual,
            top_codes,
        }
    }

    pub fn get_reports(&self, receiver: AccountId, from: u64, limit: u64) -> Vec<Report> {
        let ids = self.by_receiver.get(&receiver).cloned().unwrap_or_default();
        ids.iter()
            .skip(from as usize)
            .take(limit as usize)
            .filter_map(|i| self.reports.get(*i as u32).cloned())
            .collect()
    }

    pub fn get_report(&self, id: u64) -> Option<Report> {
        self.reports.get(id as u32).cloned()
    }

    pub fn get_trusted(&self) -> Vec<AccountId> {
        self.trusted.iter().cloned().collect()
    }

    pub fn get_manual(&self, receiver: AccountId) -> Option<String> {
        self.manual.get(&receiver).cloned()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    /// Codes `report` accepts.
    pub fn allowed_codes(&self) -> Vec<u8> {
        ALLOWED_CODES.to_vec()
    }

    pub fn stats(&self) -> Stats {
        Stats {
            receivers: self.receivers_count,
            reports: self.reports.len() as u64,
            reporters: self.reporters_count,
            trusted: self.trusted.len() as u64,
        }
    }

    /// Digest helpers so reporters can check their encoding.
    pub fn compute_digest_v2(&self, tx_hash: String, code: u8, counter: u32, receiver: AccountId) -> String {
        hex::encode(refusal_digest_v2(&parse_32(&tx_hash, "tx_hash"), code, counter, &receiver))
    }

    pub fn compute_digest_v1(&self, tx_hash: String, code: u8, counter: u32) -> String {
        hex::encode(refusal_digest_v1(&parse_32(&tx_hash, "tx_hash"), code, counter))
    }

    // ------------------------------------------------------------------ internals

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner may call this method"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn owner() -> AccountId {
        acc("owner.testnet")
    }
    fn wallet_a() -> AccountId {
        acc("fuse.alice.testnet")
    }
    fn wallet_b() -> AccountId {
        acc("fuse.bob.testnet")
    }
    fn chip(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }
    fn chip_hex(seed: u8) -> String {
        hex::encode(chip(seed).verifying_key().to_bytes())
    }
    fn ctx(predecessor: &AccountId, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc("registry.testnet"))
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor.clone())
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(0));
        b
    }
    fn new_registry() -> FuseRegistry {
        testing_env!(ctx(&owner(), 1).build());
        FuseRegistry::new(owner())
    }
    fn b64(sig: ed25519_dalek::Signature) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
    }
    fn sig_v2(seed: u8, hash: &[u8; 32], code: u8, counter: u32, receiver: &AccountId) -> String {
        b64(chip(seed).sign(&refusal_digest_v2(hash, code, counter, receiver)))
    }
    fn sig_v1(seed: u8, hash: &[u8; 32], code: u8, counter: u32) -> String {
        b64(chip(seed).sign(&refusal_digest_v1(hash, code, counter)))
    }
    const HASH: [u8; 32] = [7u8; 32];
    fn scam() -> AccountId {
        acc("scam.testnet")
    }
    /// Bound report from `reporter` about `scam()` signed by chip `seed`.
    fn report_v2(c: &mut FuseRegistry, reporter: &AccountId, seed: u8, counter: u32, code: u8) -> u64 {
        testing_env!(ctx(reporter, 1_000 + counter as u64).build());
        let s = sig_v2(seed, &HASH, code, counter, &scam());
        c.report(chip_hex(seed), scam(), hex::encode(HASH), code, counter, s, 2)
    }

    #[test]
    fn allow_when_unknown() {
        let c = new_registry();
        let v = c.check(acc("nobody.testnet"));
        assert_eq!(v.verdict, "allow");
        assert_eq!(v.reports, 0);
        assert_eq!(v.manual, None);
        assert!(v.top_codes.is_empty());
        assert_eq!(c.stats().receivers, 0);
    }

    #[test]
    fn report_v2_verifies_and_is_bound() {
        let mut c = new_registry();
        let id = report_v2(&mut c, &wallet_a(), 1, 1, 13);
        assert_eq!(id, 0);
        let r = c.get_report(0).unwrap();
        assert!(r.bound);
        assert_eq!(r.version, 2);
        assert_eq!(r.reporter, wallet_a());
        assert_eq!(r.chip_pubkey_hex, chip_hex(1));
        assert_eq!(r.receiver, scam());
        assert_eq!(r.tx_hash_hex, hex::encode(HASH));
        assert_eq!(r.counter, 1);
        assert_eq!(r.timestamp_ns.0, 1_001);
        assert!(get_logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"report\"")));
        let v = c.check(scam());
        assert_eq!(v.verdict, "warn");
        assert_eq!((v.reports, v.distinct_reporters, v.distinct_chips, v.bound_reports, v.bound_chips), (1, 1, 1, 1, 1));
        assert_eq!(v.trusted_reports, 0);
        assert_eq!(v.bound_weight, 1);
        assert_eq!(v.last_ts.0, 1_001);
        assert_eq!(v.top_codes, vec![(13, 1)]);
        let s = c.stats();
        assert_eq!((s.receivers, s.reports, s.reporters), (1, 1, 1));
        assert_eq!(c.get_reports(scam(), 0, 10).len(), 1);
        assert!(c.get_reports(scam(), 1, 10).is_empty());
    }

    #[test]
    fn report_v1_is_accepted_but_unbound() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 5).build());
        // chip_pubkey in base58 with prefix, tx_hash in base58: both forms accepted
        let pk = format!("ed25519:{}", bs58::encode(chip(1).verifying_key().to_bytes()).into_string());
        c.report(pk, scam(), bs58::encode(HASH).into_string(), 13, 1, sig_v1(1, &HASH, 13, 1), 1);
        let r = c.get_report(0).unwrap();
        assert!(!r.bound);
        assert_eq!(r.version, 1);
        assert_eq!(r.chip_pubkey_hex, chip_hex(1));
        let v = c.check(scam());
        assert_eq!(v.verdict, "warn");
        assert_eq!(v.bound_reports, 0);
        assert_eq!(v.distinct_chips, 1);
        assert_eq!(v.bound_chips, 0);
        // three unbound reports from different chips still only warn
        testing_env!(ctx(&wallet_b(), 6).build());
        c.report(chip_hex(2), scam(), hex::encode(HASH), 13, 1, sig_v1(2, &HASH, 13, 1), 1);
        c.report(chip_hex(3), scam(), hex::encode(HASH), 13, 1, sig_v1(3, &HASH, 13, 1), 1);
        let v = c.check(scam());
        assert_eq!(v.verdict, "warn");
        assert_eq!(v.reports, 3);
        assert_eq!(v.distinct_chips, 3);
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn report_rejects_forged_signature() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 5).build());
        // signed by chip 2, attributed to chip 1
        let s = sig_v2(2, &HASH, 13, 1, &scam());
        c.report(chip_hex(1), scam(), hex::encode(HASH), 13, 1, s, 2);
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn report_rejects_receiver_not_in_digest() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 5).build());
        let s = sig_v2(1, &HASH, 13, 1, &acc("innocent.testnet"));
        c.report(chip_hex(1), scam(), hex::encode(HASH), 13, 1, s, 2);
    }

    #[test]
    #[should_panic(expected = "receipt signature does not verify")]
    fn report_rejects_v1_receipt_claimed_as_v2() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 5).build());
        let s = sig_v1(1, &HASH, 13, 1);
        c.report(chip_hex(1), scam(), hex::encode(HASH), 13, 1, s, 2);
    }

    #[test]
    #[should_panic(expected = "unsupported receipt version")]
    fn report_rejects_unknown_version() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 5).build());
        let s = sig_v1(1, &HASH, 13, 1);
        c.report(chip_hex(1), scam(), hex::encode(HASH), 13, 1, s, 3);
    }

    #[test]
    #[should_panic(expected = "duplicate (chip, counter)")]
    fn replay_guard_same_reporter() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
    }

    #[test]
    #[should_panic(expected = "duplicate (chip, counter)")]
    fn replay_guard_other_reporter_same_receipt() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
        report_v2(&mut c, &wallet_b(), 1, 1, 13);
    }

    #[test]
    fn replay_guard_is_per_chip() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
        report_v2(&mut c, &wallet_a(), 2, 1, 13); // another chip, same counter: fine
        assert_eq!(c.stats().reports, 2);
    }

    #[test]
    fn block_on_two_bound_chips() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 14);
        assert_eq!(c.check(scam()).verdict, "warn");
        report_v2(&mut c, &wallet_b(), 2, 1, 19);
        let v = c.check(scam());
        assert_eq!(v.verdict, "block");
        assert_eq!(v.bound_chips, 2);
        assert_eq!(v.distinct_reporters, 2);
        assert_eq!(v.top_codes, vec![(14, 1), (19, 1)]);
        assert_eq!(c.stats().reporters, 2);
    }

    #[test]
    fn block_on_three_bound_reports_from_one_chip() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 14);
        report_v2(&mut c, &wallet_a(), 1, 2, 14);
        let v = c.check(scam());
        assert_eq!(v.verdict, "warn");
        assert_eq!(v.bound_weight, 2);
        report_v2(&mut c, &wallet_a(), 1, 3, 13);
        let v = c.check(scam());
        assert_eq!(v.verdict, "block");
        assert_eq!((v.reports, v.bound_reports, v.bound_weight, v.distinct_chips), (3, 3, 3, 1));
        assert_eq!(v.top_codes, vec![(14, 2), (13, 1)]);
        assert_eq!(v.last_ts.0, 1_003);
    }

    #[test]
    fn trusted_reporter_weighs_double() {
        let mut c = new_registry();
        testing_env!(ctx(&owner(), 1).build());
        c.trust(wallet_a());
        assert_eq!(c.get_trusted(), vec![wallet_a()]);
        assert_eq!(c.stats().trusted, 1);
        // one trusted bound report (weight 2, code != 13) -> warn
        report_v2(&mut c, &wallet_a(), 1, 1, 14);
        let v = c.check(scam());
        assert_eq!(v.verdict, "warn");
        assert_eq!((v.trusted_reports, v.bound_weight), (1, 2));
        // plus one untrusted bound report from the same chip -> weight 3 -> block
        report_v2(&mut c, &wallet_b(), 1, 2, 14);
        let v = c.check(scam());
        assert_eq!(v.verdict, "block");
        assert_eq!((v.trusted_reports, v.bound_weight, v.bound_chips), (1, 3, 1));
        // untrust: back to weight 2 -> warn
        testing_env!(ctx(&owner(), 2).build());
        c.untrust(wallet_a());
        let v = c.check(scam());
        assert_eq!(v.verdict, "warn");
        assert_eq!((v.trusted_reports, v.bound_weight), (0, 2));
    }

    #[test]
    fn trusted_receiver_not_allowed_blocks_alone() {
        let mut c = new_registry();
        // untrusted single RECEIVER_NOT_ALLOWED: warn
        report_v2(&mut c, &wallet_b(), 2, 1, CODE_RECEIVER_NOT_ALLOWED);
        assert_eq!(c.check(scam()).verdict, "warn");
        testing_env!(ctx(&owner(), 1).build());
        c.trust(wallet_b());
        // the same report now comes from a trusted reporter: block
        let v = c.check(scam());
        assert_eq!(v.verdict, "block");
        assert_eq!(v.trusted_reports, 1);
    }

    #[test]
    fn manual_block_and_clear() {
        let mut c = new_registry();
        testing_env!(ctx(&owner(), 1).build());
        c.report_manual(scam(), "phishing seller".into());
        let v = c.check(scam());
        assert_eq!(v.verdict, "block");
        assert_eq!(v.reports, 0);
        assert_eq!(v.manual, Some("phishing seller".into()));
        assert_eq!(c.get_manual(scam()), Some("phishing seller".into()));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"manual\"")));
        c.clear_manual(scam());
        let v = c.check(scam());
        assert_eq!(v.verdict, "allow");
        assert_eq!(v.manual, None);
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn report_manual_owner_only() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 1).build());
        c.report_manual(scam(), "x".into());
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn trust_owner_only() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 1).build());
        c.trust(wallet_a());
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn clear_manual_owner_only() {
        let mut c = new_registry();
        testing_env!(ctx(&owner(), 1).build());
        c.report_manual(scam(), "x".into());
        testing_env!(ctx(&wallet_a(), 1).build());
        c.clear_manual(scam());
    }

    #[test]
    #[should_panic(expected = "code is not a counterparty code")]
    fn report_rejects_amount_over_cap() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 15);
    }

    #[test]
    #[should_panic(expected = "code is not a counterparty code")]
    fn report_rejects_button_timeout_v1() {
        let mut c = new_registry();
        testing_env!(ctx(&wallet_a(), 5).build());
        c.report(chip_hex(1), scam(), hex::encode(HASH), 17, 1, sig_v1(1, &HASH, 17, 1), 1);
    }

    #[test]
    fn allowed_codes_view() {
        // Mock storage persists across new_registry() calls inside one test: count cumulatively.
        let mut c = new_registry();
        let codes = c.allowed_codes();
        assert_eq!(codes, vec![13, 14, 19]);
        for (i, code) in codes.iter().enumerate() {
            report_v2(&mut c, &wallet_a(), *code, *code as u32, *code);
            assert_eq!(c.check(scam()).reports as usize, i + 1);
        }
    }

    #[test]
    fn clear_reports_drops_receiver_and_keeps_replay_guard() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
        report_v2(&mut c, &wallet_b(), 2, 1, 14);
        assert_eq!(c.check(scam()).verdict, "block");
        testing_env!(ctx(&owner(), 9).build());
        assert_eq!(c.clear_reports(scam()), 2);
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"clear_reports\"")));
        let v = c.check(scam());
        assert_eq!(v.verdict, "allow");
        assert_eq!(v.reports, 0);
        assert!(c.get_reports(scam(), 0, 10).is_empty());
        assert_eq!(c.stats().receivers, 0);
        // records stay readable by id, total accepted reports unchanged
        assert_eq!(c.get_report(0).unwrap().receiver, scam());
        assert_eq!(c.stats().reports, 2);
        // clearing an unknown receiver is a no-op
        assert_eq!(c.clear_reports(acc("nobody.testnet")), 0);
        // the manual block is separate and survives
        c.report_manual(scam(), "still bad".into());
        assert_eq!(c.check(scam()).verdict, "block");
    }

    #[test]
    #[should_panic(expected = "duplicate (chip, counter)")]
    fn clear_reports_does_not_allow_replay() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
        testing_env!(ctx(&owner(), 9).build());
        c.clear_reports(scam());
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
    }

    #[test]
    #[should_panic(expected = "only the owner may call this method")]
    fn clear_reports_owner_only() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
        testing_env!(ctx(&wallet_a(), 9).build());
        c.clear_reports(scam());
    }

    #[test]
    fn digest_helpers_match_sha2() {
        use sha2::Digest;
        testing_env!(ctx(&owner(), 1).build());
        let c = FuseRegistry::new(owner());
        let rh = sha2::Sha256::digest(b"scam.testnet");
        let mut m = Vec::new();
        m.extend_from_slice(b"FUSE_REFUSAL_V2");
        m.extend_from_slice(&HASH);
        m.push(13);
        m.extend_from_slice(&9u32.to_le_bytes());
        m.extend_from_slice(&rh);
        assert_eq!(c.compute_digest_v2(hex::encode(HASH), 13, 9, scam()), hex::encode(sha2::Sha256::digest(&m)));
        let mut m1 = Vec::new();
        m1.extend_from_slice(b"FUSE_REFUSAL_V1");
        m1.extend_from_slice(&HASH);
        m1.push(13);
        m1.extend_from_slice(&9u32.to_le_bytes());
        assert_eq!(c.compute_digest_v1(hex::encode(HASH), 13, 9), hex::encode(sha2::Sha256::digest(&m1)));
    }

    #[test]
    fn digest_v2_bridge_vector() {
        // Shared test vector with the bridge and fuse-wallet: tx_hash = 0x01..0x20, code 13, counter 7.
        testing_env!(ctx(&owner(), 1).build());
        let c = FuseRegistry::new(owner());
        let hash: [u8; 32] = core::array::from_fn(|i| (i + 1) as u8);
        assert_eq!(
            c.compute_digest_v2(hex::encode(hash), 13, 7, acc("attacker.testnet")),
            "3091912debd71ecc48be63e3b950242d42d9f9312bf742ab25a0cfb4b972eae3"
        );
    }

    #[test]
    fn reports_index_is_per_receiver() {
        let mut c = new_registry();
        report_v2(&mut c, &wallet_a(), 1, 1, 13);
        testing_env!(ctx(&wallet_a(), 2).build());
        let other = acc("other.testnet");
        let s = sig_v2(1, &HASH, 14, 2, &other);
        c.report(chip_hex(1), other.clone(), hex::encode(HASH), 14, 2, s, 2);
        assert_eq!(c.get_reports(scam(), 0, 10).len(), 1);
        assert_eq!(c.get_reports(other.clone(), 0, 10).len(), 1);
        assert_eq!(c.get_reports(other, 0, 10)[0].code, 14);
        assert_eq!(c.check(scam()).reports, 1);
        let s = c.stats();
        assert_eq!((s.receivers, s.reports, s.reporters), (2, 2, 1));
    }
}
