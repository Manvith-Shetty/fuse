# Questions a careful reader asks

**Why not just a function-call key with an allowance?**
An allowance caps gas, not money, and a function-call key does not look inside the arguments: with only the key, the
agent could call `pay` with any receiver and any amount the contract accepts. The key is the first lock because it keeps
the agent inside one contract and three methods. The budget itself needs something that reads the bytes: the chip.

**Why not a multisig?**
A multisig asks a human to approve each transaction, which is what Fuse does only above a threshold. Below it, the
agent runs unattended and the chip is the second signer that never gets tired, never reads the invoice, and decides
from the decoded bytes. For large payments Fuse does become a two-device quorum.

**Why hardware, when a software firewall in the agent's process or in a contract does the same checks?**
A check inside the agent's process dies with the process: a compromised host can skip it, or sign the bytes directly if
the key is on the machine. A contract-only firewall still needs a key somewhere to sign the call, and that key is the
thing attackers take. Fuse puts the key where the host cannot copy it and the decision where the host cannot skip it.
The refusal is signed by something the host does not control, which is why it can be evidence.

**What if someone steals the chip?**
They have a key that can only call `pay`, `record_refusal` and `request_chain_sig` on one contract, to allowlisted
receivers, under the per-payment cap and the daily cap, with the button in their hand for anything above the threshold.
The owner pauses the contract or rotates the chip key from their wallet; the thief cannot change the policy without the
owner's signature.

**What if the owner's key is compromised?**
The owner is trusted. A compromised owner can change the policy and withdraw. Every policy change is signed and
sequenced, so it is at least visible, and the quorum setting can require a second chip for large amounts.

**What if the bridge lies to the chip?**
The chip does not use anything the bridge says. It decodes the transaction bytes itself and ignores the hint. A lying
bridge can only propose transactions, and only policy-passing ones get signed.

**Why does the chip have no clock?**
Because a clock the host sets is a clock the host controls. The chip enforces a velocity window since boot; the daily
cap lives in the contract, whose clock is the chain's.

**Why is the registry advisory instead of enforced?**
Because a shared blocklist can be gamed, and the chip must never refuse a payment on someone else's word. The registry
informs the agent and the human; the chip decides from its own policy.

**Why NEAR?**
Function-call access keys give a protocol-level lock no other chain offers natively; sub-cent fees make 0.001 NEAR API
calls viable; Chain Signatures let the same chip approve payments on Ethereum and Bitcoin; NEAR AI Cloud's signed
responses let the chip verify that an attested model made the decision.

**What is simulated?**
Anything labelled SIMULATED in the output: the software chip used by the no-hardware path and by the second "approver"
chip in the quorum demo. Everything else in `docs/claims-ledger.md` marked REAL ran on the ESP32-S3 against testnet.
