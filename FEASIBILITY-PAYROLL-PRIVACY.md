# Split: Payroll + Pay Link Privacy, Codebase Audit and Build Plan

Response to `split-payroll-vision-brief.md`. Everything below was verified against the actual code in this repo, not assumed. File references point at the exact source.

**TL;DR:**
- Pay link resolution is off-chain (Supabase lookup, server-side), the contract only ever sees raw addresses.
- Auto-split fires synchronously inside the contract on every `deposit`/`depositFor` call, unconditionally, regardless of sender. But it only fires for payments routed through the contract. A raw USDC transfer to a user's wallet address does not split.
- The account model is strictly one address per user, at both the contract and database level.
- **Payroll: moderate new work.** One new contract, new tables, new UI. Nothing existing needs to change.
- **Privacy: requires new architecture, plus one product decision the brief has not made yet.** Auto-split on arrival and stealth unlinkability are mutually exclusive at the moment of payment in the current design. There is a good resolution, but it means stealth payments split at claim time, not arrival time.

---

## 1. Codebase Audit: Answers to the Brief's Open Questions

### 1.1 How pay-link-to-address resolution actually works today

**Answer: entirely off-chain, in two steps. The contract never sees a link, handle, or identifier of any kind.**

The flow, traced through the code:

1. A pay link is `/pay/{handle}` (or `/pay/{rawAddress}`). Links are generated in [profile/page.tsx:392](app/app/profile/page.tsx) as `{origin}/pay/{handle}`.
2. When someone opens the link, the **Next.js server component** [app/pay/[handle]/page.tsx:17-52](app/pay/[handle]/page.tsx) runs `resolveRecipient()`: a Supabase query against `profiles` (`handle` column, lowercased) that returns the row's `address`. The `profiles` table ([001_initial.sql:9-16](supabase/migrations/001_initial.sql)) is `address text primary key, handle text unique`.
3. The resolved raw address is passed as a prop into the **client component** [pay-form.tsx](app/pay/[handle]/pay-form.tsx), which has the payer's wallet call `Split.depositFor(recipientAddress, amount)` directly ([pay-form.tsx:204](app/pay/[handle]/pay-form.tsx)). If a note is attached, the call is wrapped through Arc's protocol memo contract ([lib/memos.ts:4-18](lib/memos.ts)), which preserves `msg.sender`.

So of the brief's two hypotheses, it is the first: **client-side resolution** (more precisely, server-side DB lookup feeding a client-side transaction). The contract's `depositFor` ([Split.sol:129-133](contracts/src/Split.sol)) accepts only a raw `address recipient`. There is no on-chain identifier resolution of any kind, and the handle registry lives only in Supabase.

**Consequence for payroll:** exactly as the brief anticipated for this branch. Batch disbursement needs the handle-to-address resolution run upfront, server-side, for the whole payee list, before the batch transaction is built. The good news: that resolution is one indexed Supabase query per handle, cheap and already battle-tested by the pay page.

**Consequence the brief did not anticipate:** because resolution is a mutable off-chain DB row, the handle-to-address mapping is a trust point. See Section 7.2.

### 1.2 Does an incoming payment already trigger bucket-split automatically and unconditionally?

**Answer: yes, but only for payments that go through the contract. And "unconditionally" comes with two revert conditions that matter enormously for batching.**

- `deposit(amount)` and `depositFor(recipient, amount)` ([Split.sol:123-133](contracts/src/Split.sol)) both `safeTransferFrom` the USDC in and then call `_split()` **synchronously, in the same transaction**. There is no separate trigger, watcher, or deferred job. The payer's transaction does the splitting and the payer pays the gas for it. Source of payment is irrelevant: `depositFor` can be called by anyone for any recipient.
- The receiving-side claim in the brief ("likely needs no new code") is **confirmed for payroll**, with one caveat below. A payroll contract calling `depositFor` per Split-user payee gets the recipient's full bucket routing for free, identically to a pay-link payment today.
- **Caveat 1, the revert conditions:** `_split()` reverts with `NoBuckets` if the recipient has zero buckets, and with `InvalidBPSTotal` if the recipient's active buckets do not sum to exactly 10,000 bps ([Split.sol:138-139](contracts/src/Split.sol)). The pay form works around this today by disabling the send button when the recipient has no buckets ([pay-form.tsx:299-303](app/pay/[handle]/pay-form.tsx)). In a naive batch, **one payee with a broken bucket config reverts the entire payroll run**. This single fact shapes most of the payroll contract design (Section 3, Bottleneck 1).
- **Caveat 2, the boundary:** a plain ERC-20 `transfer` of USDC straight to a user's wallet address never touches the contract and never splits. "Money auto-splits the moment it arrives" is true only for contract-mediated arrivals. This matters for the stealth design, where payments cannot go through the contract without destroying the privacy property (Section 1.4).

### 1.3 One address per user, or could the model support multiple?

**Answer: strictly one address per user today, at every layer.**

- **Contract:** all state is keyed by a single address. `mapping(address => Bucket[]) userBuckets` ([Split.sol:35](contracts/src/Split.sol)). A "user" *is* an address.
- **Database:** `profiles.address` is the primary key, `handle` is unique per address ([001_initial.sql:9-16](supabase/migrations/001_initial.sql)). There is no user entity above the address.
- **Frontend:** `useAccount()` from wagmi everywhere; the connected wallet address is the identity.
- **Auth:** profile writes are authorized by a wallet signature verified with `verifyMessage` against that same single address ([app/api/profile/route.ts:44-47](app/api/profile/route.ts)).

**Can it support multiple addresses?** Not without change, but the change required depends on which feature needs it:

- **Payroll needs nothing here.** The payer side never required an account model change.
- **Stealth needs it, but not in the contract.** The correct stealth design (Section 4.3) keeps bucket config keyed to the one main address exactly as today, and treats stealth addresses as external fund locations that are *associated* with an account off-chain (via the announcement scan) and only touch the Split contract at claim time, if ever. That means the multi-address support lives in: a new Supabase table mapping announcements/stealth outputs to accounts (populated by client-side scanning), and client-side key material. `Split.sol` does not need to learn about multiple addresses, which is the single biggest scope containment in this whole plan.

### 1.4 Can bucket-split be re-keyed to "any address provably belonging to account X"?

**Answer: no, and this is not an implementation gap. It is a logical conflict, and it is the most important finding in this document.**

The brief asks (ask #5) whether split logic can trigger on "payment to any address provably belonging to account X." On a public chain, submitting that proof to the contract *is the act of publishing the link* between the stealth address and account X. The whole point of EIP-5564 is that only the recipient can compute the connection; the moment a transaction says "this stealth address belongs to the account with these buckets," every property the feature was built for is gone, retroactively, for that payment.

Concretely in this codebase: `_split()` emits `Deposited(recipient indexed, sender indexed, amount)` and per-bucket `BucketSplit(user indexed, ...)` events ([Split.sol:43-44](contracts/src/Split.sol)), and the indexer cron writes them all to a **publicly readable** activity table ([001_initial.sql:87-88](supabase/migrations/001_initial.sql), `activity_public_read` policy). The Split contract is, structurally, a linking machine. That is a feature for reconciliation and a direct contradiction of unlinkability.

So the honest framing is: **auto-split-on-arrival and stealth privacy cannot both hold for the same payment.** The resolution is a product decision, not a technical trick:

- **Stealth payments do not auto-split on arrival.** They land as plain USDC transfers at fresh stealth addresses, announced via the EIP-5564 announcer. The recipient's app detects them by scanning.
- **Splitting happens at claim time, under the user's control**, with two selectable modes, Quick Claim and Private Claim, that trade privacy against convenience (detailed in Section 3, Bottleneck 4).

This is still a strong product. "Your pay link stops being a permanent public record of your income" survives intact. "Money splits the instant it arrives" becomes "money splits when you claim it, one tap, and you choose the privacy level of the claim." The brief should be updated to say this plainly rather than implying stealth payments flow into buckets automatically.

### 1.5 Other verified facts that shape the plan

- **Chain:** Arc Testnet, chain id 5042002, roughly 0.48s blocks, three RPC endpoints with failover ([lib/chain.ts](lib/chain.ts)). Gas is paid in USDC (native currency, 18 decimals for gas accounting) while the payment asset is the ERC-20 USDC interface at `0x3600...0000` with 6 decimals ([lib/contracts.ts:22](lib/contracts.ts)). Multicall3 is deployed on Arc ([lib/chain.ts:38](lib/chain.ts)), usable for batched *reads*, not for `transferFrom`-based writes (msg.sender would become the multicall contract).
- **Off-chain infra pattern:** two cron routes. An indexer ([app/api/cron/index/route.ts](app/api/cron/index/route.ts)) walks blocks cursor-style (1,000 blocks per run), decodes Split and Memo events, and upserts idempotently into Supabase. A scheduler ([app/api/cron/send/route.ts](app/api/cron/send/route.ts)) executes due scheduled sends, capped at 5 per run to fit Vercel's 10-second function limit, signing with a hot `SCHEDULER_PRIVATE_KEY`. Both patterns are directly reusable; the Vercel time limit and the hot-key precedent both carry warnings (Section 7).
- **Existing standing constraint:** the project has a hard no-touch list covering `contracts/` (all existing files), `lib/contracts.ts`, `lib/arc.ts`, `lib/bps.ts`, and all existing `app/api/` routes. Everything in this plan is therefore designed as **new files only**: a new contract, new lib modules, new API routes, new migrations. The two places where extending an existing file would be the natural move (the indexer cron and `lib/contracts.ts`) get parallel new files instead, and Section 4 flags where that costs a little duplication.

---

## 2. Feasibility Read

No softening, as requested.

### 2.1 Payroll / batch disbursement: **moderate new work**

Not a "straightforward extension," and here is precisely why: there is no batch primitive anywhere in the system, `depositFor`'s revert semantics make naive batching fragile (one bad payee bricks the run), and `msg.sender`-based `transferFrom` rules out generic multicall batching. So payroll needs one genuinely new smart contract with careful failure isolation, and that contract handles real money in the largest single transactions the product will ever send. That is contract engineering with tests and review, not a UI feature.

But it is honest to say **nothing about the existing architecture resists it**. `Split.sol` needs zero changes. The receiving side already works. Resolution is a solved query. The roster, diff-verification, and history are conventional web work on patterns this repo already uses (signature-authed API routes, Supabase tables, wagmi write flows). A competent build is a few weeks, not a rethink.

### 2.2 Pay link privacy / stealth addresses: **requires new architecture**

Three separate reasons, in decreasing order of severity:

1. **The product conflict in Section 1.4.** Not code, a decision. Until "stealth payments split at claim, not arrival" is accepted, this feature cannot be specified honestly.
2. **A full new subsystem with client-side cryptography.** Meta-address key derivation from wallet signatures, per-payment stealth address computation on the payer's device, announcement scanning with view tags, claim transaction building from ephemeral private keys. None of this exists in the repo and none resembles anything in it. Good references exist (Section 5), and Arc removes the worst infrastructure burden other chains have (Section 7.1), but this is new territory with key-loss failure modes that can permanently strand funds.
3. **Protocol infrastructure Arc does not have.** The canonical ERC-5564 Announcer and ERC-6538 Registry singletons exist on major EVM chains but almost certainly not on Arc Testnet. They must be deployed as part of this work (they are small, audited, open-source contracts, so this is a task, not a risk, but it is on the critical path).

Sequencing consequence: **build payroll first.** It ships value alone, shares the resolution infrastructure stealth needs, and the payee roster becomes the natural home for "this contractor accepts private payments" once stealth lands.

---

## 3. Bottlenecks and Solutions

Every real bottleneck found, each with at least one concrete solution. Tradeoffs named where they exist.

### Bottleneck 1: One bad payee reverts the whole batch

`_split()` reverts on `NoBuckets` or `InvalidBPSTotal` ([Split.sol:138-139](contracts/src/Split.sol)). Any Split-user payee who deleted their buckets, or whose bps do not sum to 10,000, kills the entire payroll transaction. A payee can even change buckets between the employer's preview and execution.

- **Solution A (on-chain isolation):** the new payroll contract wraps each `depositFor` in `try/catch`. On failure it falls back to a plain USDC `transfer` to the payee's address (money arrives, just unsplit, same as paying a non-Split recipient) and emits a per-payee outcome event so the UI can show "sent, but their split rules were broken so it went straight to their wallet."
- **Solution B (off-chain pre-validation):** immediately before execution, read `getBuckets` + `totalBPS` for every Split payee (one Multicall3 read batch) and warn on any broken config.
- **Tradeoff:** A is robust but slightly more gas and hides config problems behind a fallback; B is clean UX but has a race window (buckets can change after the check, Arc blocks are sub-second). **Do both:** B for a good preview, A so the race can never burn a run. Do not pick B alone; the failure mode is an employer's entire payroll reverting at 5pm on payday.

### Bottleneck 2: No usable batching primitive exists

`depositFor` pulls funds via `safeTransferFrom(msg.sender, ...)`, so Multicall3 cannot batch it (the multicall contract would become the spender). Sending N separate transactions from the employer's wallet defeats the "one action" requirement and multiplies failure modes.

- **Solution:** a dedicated `SplitPayroll` contract: employer approves it for the run total, one `runPayroll(payees[])` call pulls the total once, then per payee either calls `Split.depositFor` (Split users, contract approves Split for the subtotal) or transfers plainly (non-users). Stateless, holds funds only within the transaction, returns any residue to the employer at the end. This is the standard "disperse" pattern (see disperse.app lineage in Section 5) plus Split-awareness.
- **Alternative considered and rejected:** adding `batchDepositFor` to `Split.sol`. Cleaner gas, but it means modifying and redeploying the audited live contract that holds user hold-bucket balances, violating the standing no-touch constraint and putting existing funds in blast radius for a payer-side feature. Not worth it.

### Bottleneck 3: Batch size ceiling (gas and platform limits)

Per Split-payee cost is roughly a `transferFrom` plus up to `MAX_BUCKETS = 10` bucket iterations, each an `SSTORE` (hold) or ERC-20 `transfer` (auto-send) plus events: estimate **120k to 350k gas per Split payee** depending on bucket count and destination warmth, about 60k per plain-transfer payee. A 50-person run could plausibly hit 6M to 15M gas. Arc's block gas limit is not documented in this repo and must be measured (Phase 0). Separately, Vercel's 10s function limit ([cron/send/route.ts:10-13](app/api/cron/send/route.ts) already fights it) rules out any server-side send loop.

- **Solution A (chunking):** `SplitPayroll` enforces a max payees-per-call (set from Phase 0 benchmarks, likely 20 to 40); the UI splits large rosters into sequential chunk transactions, each atomic, with a run-level progress record in the DB so a failed chunk N does not re-send chunks 1 through N-1.
- **Solution B (client executes, server only prepares):** execution is always a wallet transaction signed by the employer in the browser. The server's role ends at resolution + verification + calldata preparation. This also kills the custody question dead: no server key ever touches payroll funds.
- **Tradeoff (A):** chunking sacrifices whole-run atomicity for large rosters; a mid-run failure leaves payroll partially executed. The run record + resume UX must make this a visible, recoverable state rather than a silent one. All-or-nothing across chunks is not achievable without holding funds in the contract across transactions, which crosses into custody; name it, accept it.

### Bottleneck 4: Auto-split vs. unlinkability (the structural one)

Fully argued in Section 1.4. Stealth payments cannot trigger today's on-arrival split without publicly linking the stealth address to the account.

- **Solution: split at claim time, with two user-selectable claim modes: Quick Claim and Private Claim.** (These names are used throughout the rest of this document.)
  - **Quick Claim:** stealth address approves, then calls `Split.depositFor(mainAddress, amount)`. (Not `deposit()`: that splits for `msg.sender`, and the stealth address has no buckets, so it would revert with `NoBuckets`.) Full bucket routing applies. Publicly links *that one stealth address* to the account at claim time; the sender-to-you link stays hidden (the payer's counterparty was the stealth address, and payment-time observers learned nothing). **Claim mechanics, DECIDED (not an open option):** two on-chain transactions (exact-amount approve, then `depositFor`), zero wallet popups. The stealth key is computed and held by the app, never by the user's wallet, so the app signs both transactions locally and fires them back-to-back; on Arc's sub-second blocks the whole claim is one tap and roughly a second. Gas is paid by the stealth address itself from the received USDC (Phase 0 finding 2). The Phase 0 EIP-3009 finding makes a single-transaction claim periphery possible later, but it is not part of this build.
  - **Private Claim:** the client computes bucket shares locally (mirror `_split()` math in TypeScript with the same floor-division remainder rule) and sends plain transfers from the stealth address straight to each bucket destination, never touching the Split contract. No single linking event. Hold-mode buckets are the complication: their "destination" is contract state, not an address, so a fully private claim either sends the hold share to the user's main address (a partial link) or to a fresh self-owned stealth address (no link, but the funds sit outside the contract's hold accounting).
  - **Wallet-reuse caveat for Private Claim:** routing any Private Claim payout to a wallet that has ever been used for ordinary Split activity (or any other public activity) inherits that wallet's entire existing exposure. The claim itself leaked nothing, but the destination already did. Private Claim is only as private as the least private address it pays into.
  - **Rejected alternative: a fresh disposable wallet per payment.** Considered and rejected. It just re-implements stealth addresses by hand with worse properties: N payments produce N keys the user must never lose (guaranteed eventual loss or an app that custodies keys, both unacceptable), and the money still has to reach a persistent spending wallet eventually, at which point the consolidation publishes the same links Private Claim was avoiding. Stealth addresses already are disposable wallets, with deterministic recovery from one seed signature; a second disposable layer adds risk without adding privacy.
  - **Honest limitation, stated plainly:** Private Claim protects funds that can sit untouched (savings, tax reserves, anything parked). It does not protect a wallet that must stay persistent for day-to-day spending, because a spending wallet re-accumulates public history with every outgoing payment, and everything routed into it inherits that history. The realistic promise is "your income trail is private," not "your spending wallet is private."
  - **Tradeoff, stated:** Quick Claim leaks one link per claim and keeps hold buckets working perfectly; Private Claim leaks nothing directly but is statistically correlatable (timing + amounts) and degrades hold buckets. Ship Quick Claim first, Private Claim as an explicit "maximum privacy" option with its correlation caveat written in the UI, not implied away.

### Bottleneck 5: No EIP-5564/6538 infrastructure on Arc

The canonical singleton deployments (Announcer at `0x5564...`, Registry at `0x6538...`) will not exist on Arc Testnet.

- **Solution:** vendor and deploy ScopeLift's reference contracts (Section 5) with the existing Foundry setup ([contracts/](contracts/) already uses forge + a Deploy script pattern). They are tiny, audited, and permissionless. One-time task, Phase 0/3.

### Bottleneck 6: Announcement scanning cost and privacy

A recipient must find their payments among *all* announcements ever emitted. Scanning raw chain history from the browser on every load does not scale, but letting the server filter "which announcements are mine" hands the account-to-stealth mapping to the server, recreating the privacy problem one layer up.

- **Solution A (indexer + client-side filtering):** a new cron route indexes all `Announcement` events into a Supabase table (same cursor pattern as the existing indexer). The client downloads announcements in bulk and filters **locally** using the EIP-5564 view tag (a 1-byte fast-reject that eliminates ~255/256 candidates before any elliptic-curve math). The server never learns which announcements matched.
- **Solution B (server-side scanning with the view key):** user uploads their viewing key; server pre-matches and pushes results. Much better UX (works with the app closed, enables notifications), but the server can now see every payment the user receives.
- **Tradeoff:** A is the honest default for a privacy feature; B is an opt-in convenience with an explicit disclosure. Do A first; offer B later, clearly labeled, if users ask.

### Bottleneck 7: Stealth key management

Stealth spending/viewing keys must be deterministic (re-derivable on any device from the wallet alone) or users will permanently lose access to funds sitting at stealth addresses.

- **Solution:** derive both keypairs from a wallet signature over a fixed, versioned, domain-separated message (the Umbra/Fluidkey pattern, both listed in Section 5). Never store spending keys anywhere. Cache the viewing key at most in-memory or, if persisted for UX, encrypted client-side. Hard rule carried over from the project's standing constraints: the app never asks for, transmits, or stores a raw private key.
- **Residual risk to state plainly:** any wallet whose signatures are not deterministic (some MPC/smart wallets) breaks re-derivation. Detect by double-signing at setup and comparing; block stealth setup with an explanation if signatures differ.

### Bottleneck 8: The handle-to-address mapping is a spoofable trust point at payroll scale

Resolution is a mutable Supabase row (Section 1.1). A compromised DB, a hijacked handle, or a payee whose handle was released and re-registered silently redirects that payee's salary, forever, with no on-chain trace of anything abnormal. Today's single-payment flow shows the resolved address to a human payer who knows the recipient; a batch run does not get that check per payee.

- **Solution A (address pinning, mandatory):** the roster stores the *resolved address* at the moment a payee is added, alongside the handle. Every run re-resolves and **hard-blocks on mismatch** until the employer explicitly re-confirms the new address. This is the brief's pre-send verification requirement (#3), made stronger: not just "flag what changed," but "refuse to send to a changed address without explicit human re-approval."
- **Solution B (on-chain second source, later):** once the ERC-6538 Registry is deployed for stealth, it doubles as an on-chain, signature-gated identity anchor; the roster can cross-check DB resolution against it.
- **Tradeoff:** A adds friction exactly when a legitimate payee rotates wallets; that friction is the feature. B adds a second lookup and only covers users who registered.

### Bottleneck 9: Activity attribution and reconciliation for batches

The indexer records `Deposited.sender` from the event, which for payroll deposits will be the `SplitPayroll` contract address, not the employer. Recipient activity feeds would show salary arriving from an anonymous contract. Additionally, the existing memo flow wraps exactly one call ([lib/memos.ts](lib/memos.ts)), so per-payee notes ("July 2026 salary") do not fit the current pattern, and the existing indexer route is on the no-touch list.

- **Solution:** `SplitPayroll` emits its own events: `PayrollRun(employer indexed, runId, total, payeeCount)` and per-payee `PayrollPayment(employer indexed, payee indexed, amount, outcome, memoHash)`, with a per-payee memo string or hash in calldata. A **new** cron route (`app/api/cron/payroll-index`) indexes these into the activity table with a new event type, leaving the existing indexer untouched per the standing constraint. The recipient's feed then shows "Payroll from {employer}" resolved via the employer's profile handle.

### Bottleneck 10: Payroll payments to stealth-enabled payees still publish the salary table

Even with stealth recipients, one payroll transaction publicly shows N transfer amounts side by side. EIP-5564 hides *who*, never *how much*. The brief says amount transparency plainly for privacy in general, but misses that batching makes it worse: a single tx is a self-labeled, timestamped salary distribution.

- **Solution A (accept and disclose):** ship as-is, document that amounts are public and recipients are unlinkable (still a real improvement: observers see a salary histogram but cannot attach any amount to any person).
- **Solution B (per-payee decorrelation):** optional mode that splits a payroll run into individually submitted transfers with randomized ordering and small time jitter, at the cost of the single-action UX and atomicity.
- **Tradeoff:** A keeps the product promise ("one batch action") and is the right default; B exists for employers who care more about the distribution being unobvious than about one-click. Choose A now, keep B in the backlog, do not silently pretend the histogram leak is not there.

---

## 4. Integration Plan

Where every new piece lives, what gets touched, what stays alone, and what breaks if built carelessly. Everything respects the standing no-touch list: **all new files, zero edits to existing contracts, existing API routes, `lib/contracts.ts`, `lib/arc.ts`, or `lib/bps.ts`.**

### 4.1 New on-chain code (`contracts/src/`, new files only)

| File | What it is |
|---|---|
| `contracts/src/SplitPayroll.sol` | The batch disburser. `runPayroll(Payee[] calldata, uint256 runId)` where `Payee = {address dest, uint128 amount, bool isSplitUser, bytes32 memoHash}`. Pulls total once from employer, loops: `try Split.depositFor` for Split users with plain-transfer fallback, plain transfer for others. Emits `PayrollRun` + `PayrollPayment` per payee. Stateless, no owner, no held funds, hard `MAX_PAYEES` cap. References Split only through its external interface; `Split.sol` itself is never modified. |
| `contracts/src/vendor/ERC5564Announcer.sol`, `ERC6538Registry.sol` | Vendored verbatim from ScopeLift's reference repo. Deployed once to Arc Testnet. |
| `contracts/src/StealthPayGateway.sol` | The payer-side periphery for private payments (decided flow, see 4.3). One external function taking an EIP-3009 `receiveWithAuthorization` signature plus the stealth payment parameters (stealth address, ephemeral pubkey, view tag, encrypted-note metadata): pulls the authorized USDC from the payer, forwards it to the computed stealth address, and calls the ERC-5564 Announcer, all atomically in one transaction. Transfer and announcement can never be separated, which eliminates the fund-stranding failure mode of a transfer that lands without its announcement. Uses `receiveWithAuthorization` (not `transferWithAuthorization`) so only this gateway, as the authorization's named payee, can execute it, closing the EIP-3009 front-running gap. Stateless, no owner, holds funds only within the transaction. EIP-3009 support on Arc's USDC was verified live in Phase 0 (finding 5). |
| `contracts/test/SplitPayroll.t.sol` | Forge tests, same style as the existing 46-test [Split.t.sol](contracts/test/Split.t.sol): happy path, per-payee fallback on `NoBuckets`/`InvalidBPSTotal`, residue return, max-size gas benchmark, reentrancy. |
| `contracts/test/StealthPayGateway.t.sol` | Forge tests for the gateway: happy path (pull + forward + announce in one tx, event contents exact), authorization replay rejected, wrong-payee authorization rejected, expired/not-yet-valid windows, zero-amount, announcement emitted iff transfer succeeded (atomicity), reentrancy. |
| `contracts/script/DeployPayroll.s.sol`, `DeployStealth.s.sol` | Deploy scripts mirroring [Deploy.s.sol](contracts/script/Deploy.s.sol). `DeployStealth` deploys the vendored Announcer + Registry and `StealthPayGateway` (which takes the Announcer address as a constructor arg). |

### 4.2 New frontend/lib code (new files only)

| File | What it is |
|---|---|
| `lib/payroll-contracts.ts` | `SplitPayroll` address getter + ABI. A sibling of `lib/contracts.ts`, created new so the no-touch file is never edited. Cost of the constraint: the `erc20Abi` import comes from `lib/contracts.ts` (importing from it is fine, editing it is not). |
| `lib/stealth.ts` | EIP-5564 client crypto: key derivation from wallet signature, stealth address generation for payers, EIP-3009 `receiveWithAuthorization` typed-data builders for the `StealthPayGateway` flow, view-tag scanning filter, claim tx builders (Quick Claim and Private Claim, app-signed with the computed stealth key). Wraps `@scopelift/stealth-address-sdk` where possible rather than hand-rolling curve math. |
| `lib/payroll.ts` | Roster types, run-total math (6-decimal USDC, `parseUnits` pattern from the pay form), chunking logic, diff-verification pure functions (unit-testable without a browser). |
| `app/app/payroll/page.tsx` + components | Employer surface: roster CRUD, run preview with resolution + bucket pre-validation results, the diff/confirmation gate, execute + chunk progress, run history. Lives beside the existing `app/app/*` pages, uses the same wagmi patterns as [pay-form.tsx](app/pay/[handle]/pay-form.tsx). |
| `hooks/use-payroll.ts` | Data hooks, sibling to [use-routed-totals.ts](hooks/use-routed-totals.ts). |

### 4.3 New API routes and migrations (new files only)

| Piece | What it is |
|---|---|
| `supabase/migrations/002_payroll.sql` | `payrolls` (employer_address, name), `payees` (payroll_id, label, handle, **pinned_address**, amount_raw, active), `payroll_runs` (run_id, employer, status, chunk progress, totals), `payroll_run_items` (per-payee snapshot + outcome). RLS: deny public, all access via signature-authed server routes. |
| `supabase/migrations/003_stealth.sql` | `stealth_meta` (address pk, stealth_meta_address, registered_at), `announcements` (indexer-fed, public-read is fine, announcements are public chain data), stealth indexer cursor row. |
| `app/api/payroll/*` | Roster CRUD + `resolve` (batch handle-to-address + `getBuckets` pre-validation + pinned-address diff) + run recording. Auth: `verifyMessage` wallet-signature pattern copied from [app/api/profile/route.ts](app/api/profile/route.ts). |
| `app/api/cron/payroll-index/route.ts` | New cursor-based indexer for `SplitPayroll` events, cloned from the existing indexer's structure, writing `payroll` event types into `activity`. New route because the existing one is no-touch. Cost: a second cursor row and some structural duplication; benefit: zero risk to the working indexer. |
| `app/api/cron/stealth-index/route.ts` | Same pattern for `Announcement` events into `announcements`. |
| Pay page privacy fork | **Payer-side flow, DECIDED (not an open option):** two wallet interactions, one signature and one atomic transaction. The payer's client computes the stealth address, then (1) the payer signs one EIP-712 typed-data `receiveWithAuthorization` naming `StealthPayGateway` as payee (a signature, not a transaction), and (2) the payer submits one transaction to `StealthPayGateway`, which atomically pulls the authorized funds, forwards them to the computed stealth address, and emits the announcement. Same interaction count as today's ordinary approve + `depositFor` payment, with atomicity today's flow does not have. There is no separate transfer step and no separate announce step. Built as a new component `app/pay/[handle]/stealth-pay-form.tsx`, selected by the server page when the recipient has registered stealth meta, leaving the existing form byte-identical for non-stealth recipients (respecting the no-touch spirit: pay-form is not on the list, but wallet-call logic patterns are). |

### 4.4 What existing logic is touched vs. left alone

**Left completely alone:** `Split.sol` and all deployed contract state, both existing cron routes, all existing API routes, `lib/contracts.ts` / `lib/arc.ts` / `lib/bps.ts`, the existing pay form for non-stealth recipients, bucket UI, scheduled sends, profiles schema (new tables only, no altered columns).

**Touched, with sign-off needed:** (1) the server component [app/pay/[handle]/page.tsx](app/pay/[handle]/page.tsx) gains a query for stealth meta and conditionally renders the stealth form, a small, reviewable diff; (2) navigation in the app shell to expose the payroll page; (3) `vercel.json` cron entries for the two new indexer routes. Nothing else.

### 4.5 What breaks if this is built carelessly

1. **Batching by looping `depositFor` without try/catch:** one payee deleting their buckets reverts entire payroll runs forever until manually diagnosed. (Bottleneck 1.)
2. **Trusting handles instead of pinned addresses in the roster:** a re-registered or hijacked handle silently redirects someone's salary. (Bottleneck 8.)
3. **Routing stealth payments through `depositFor` "so buckets still work":** publicly links every stealth address at payment time; the feature becomes decorative. (Section 1.4.)
4. **Server-side batch execution with a hot key:** copies the scheduler pattern into a context holding payroll-sized funds; a leaked env var becomes a drained payroll. Execution must stay in the employer's wallet. (Bottleneck 3B.)
5. **Non-deterministic stealth key derivation, or storing spending keys:** stranded funds or a honeypot, respectively. (Bottleneck 7.)
6. **Modifying `Split.sol` for batching:** redeployment, migration of live hold balances, and blast radius on the working product for a payer-side convenience. (Bottleneck 2, rejected alternative.)
7. **Letting the payroll contract hold funds across transactions** (for cross-chunk atomicity): turns a router into a custodian, with everything that implies. Keep it stateless within a single tx.
8. **Skipping the run-record/resume model for chunked runs:** a mid-run failure with no record produces double payments on retry. Run items must be written before execution and reconciled from chain events after.

---

## 5. Tools, Libraries, and Reference Implementations (all free/open-source)

| Tool | What it's for | Where |
|---|---|---|
| **ScopeLift stealth-address-erc-contracts** | Canonical ERC-5564 Announcer + ERC-6538 Registry Solidity implementations to vendor and deploy on Arc | github.com/ScopeLift/stealth-address-erc-contracts |
| **@scopelift/stealth-address-sdk** | TypeScript SDK: meta-address encoding, stealth address generation, view-tag scanning. Wraps the curve math so `lib/stealth.ts` stays thin | npm / github.com/ScopeLift/stealth-address-sdk |
| **Umbra protocol (umbra-js)** | Production-proven reference for signature-based key derivation, scanning UX, and claim flows. Read for patterns, not as a dependency | github.com/ScopeLift/umbra-protocol |
| **Fluidkey stealth-account-kit** | Alternative audited key-derivation reference (deterministic keys from signatures) | github.com/fluidkey/stealth-account-kit |
| **EIP-5564 / ERC-6538 specs** | The actual standards, including view-tag spec | eips.ethereum.org/EIPS/eip-5564, eips.ethereum.org/EIPS/eip-6538 |
| **@noble/curves + @noble/hashes** | Audited secp256k1/keccak primitives if anything must be hand-built; already in the dependency tree transitively via viem | npm |
| **disperse.app contract lineage** | The minimal, battle-tested batch-transfer pattern `SplitPayroll` extends | github.com/banteg/disperse (etherscan-verified originals) |
| **Multicall3** | Batched *reads* for pre-validation (`getBuckets`/`totalBPS` for the whole roster in one RPC call); already deployed on Arc per [lib/chain.ts:38](lib/chain.ts) | github.com/mds1/multicall |
| **Foundry (forge/anvil)** | Already the repo's contract toolchain; anvil for gas-limit probing and fork tests | getfoundry.sh |
| **OpenZeppelin Contracts** | SafeERC20/ReentrancyGuard for `SplitPayroll`, already vendored in `contracts/lib` | github.com/OpenZeppelin/openzeppelin-contracts |
| **viem / wagmi / RainbowKit** | Already in package.json; no new wallet stack needed | existing |
| **Circle Arc docs + testnet faucet** | Block gas limit, native-USDC/ERC-20 duality verification (Phase 0), faucet for stealth claim testing | docs.arc.network (and Circle developer docs) |

Nothing on this list costs money. The only paid-adjacent item anywhere in the plan is an eventual professional audit before real-money mainnet payroll, which is out of scope here but named in Section 7.

---

## 6. Phased Build Plan

Ordered by dependency and risk (highest-uncertainty items first, so failures happen cheap), not by difficulty.

### Phase 0: De-risk spikes (days, not weeks)

**What:** Five questions answered with throwaway code before any real building.
1. Measure Arc's block gas limit and benchmark `SplitPayroll`-shaped batches with forge gas reports to fix `MAX_PAYEES`.
2. Verify the native-USDC / ERC-20 duality question: does a stealth EOA that received ERC-20 USDC (`0x3600...`) have native gas to send its own claim transaction? (If yes, Arc eliminates the gas-relayer infrastructure every other chain's stealth system needs, a major simplification. If no, claiming needs a relayer design and Phase 3 grows.)
3. Deploy ScopeLift's Announcer + Registry to Arc Testnet; confirm events index cleanly.
4. Sign the same key-derivation message twice from the actual target wallets (MetaMask at minimum) to confirm deterministic signatures.
5. Check whether Arc's USDC at `0x3600...` supports EIP-2612 `permit` (call `DOMAIN_SEPARATOR()`, `nonces(address)`, and `eip712Domain()`). If yes, a small periphery contract can make both the payer's private payment and the recipient's Quick Claim a single atomic transaction (permit signature + one call) instead of approve-then-act pairs.

**Why this phase exists:** items 1 and 2 change the design of everything downstream (batch caps; whether claiming is trivial or needs a relayer). Discovering them mid-build is the expensive version.
**Done when:** all five have written answers with numbers/tx hashes in a short findings note.

#### Phase 0 findings (run 2026-07-21, Arc Testnet chain 5042002, via rpc.testnet.arc.network + local forge)

1. **Block gas limit: 30,000,000** (read from latest block, height 52,968,649; baseFee 20 gwei). Forge benchmark of the `SplitPayroll` prototype (pull-once, per-payee try/catch, 3-bucket recipients, per-payee events, residue return): 10 payees = 647,719 gas; 25 = 1,424,684; 50 = 2,793,113; 100 = 5,531,730 (~55k per Split payee steady state); mixed run of 30 split + 10 broken-config fallbacks + 10 plain = 2,388,879. A 100-payee chunk uses ~18% of the block limit, and costs roughly 0.11 USDC at the observed base fee. `MAX_PAYEES = 100` is comfortably safe. Caveat: measured against a mock ERC-20 with warm storage; re-benchmark on testnet in Phase 1 against the real `0x3600...` facade before freezing the cap.
2. **Native/ERC-20 duality: CONFIRMED.** The ERC-20 facade at `0x3600...` (real contract, 1,798 bytes, `decimals() = 6`, `name() = "USDC"`) is a 6-decimal view of the same balance `eth_getBalance` reports at 18 decimals. Split contract: `balanceOf` 29,160,000 vs native 29,160,000,000,000,000,000 (exactly x10^12). An active EOA showed `balanceOf` 212,526 vs native 212,526,317,032,169,105: same balance, with sub-6-decimal gas dust visible only in the native view, proving one shared pot. **A stealth address that receives ERC-20 USDC can pay its own claim gas. No relayer needed.** This was the biggest open risk in the privacy plan and it is now closed.
3. **ERC-5564 Announcer / ERC-6538 Registry: NOT deployed on Arc Testnet.** `eth_getCode` at the canonical singleton addresses (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`, `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`) returns `0x` for both. Deploying the ScopeLift reference contracts is on us, as planned. Remaining action: a funded deployer key must run the forge deploy script (user action; nothing in this repo's tooling should ever handle that key automatically).
4. **Deterministic wallet signatures: NOT YET RUN, requires the actual target wallet.** This spike is a two-minute manual check: sign the same fixed derivation message twice in MetaMask (and any other wallet that will be supported) and confirm byte-identical signatures. Standard MetaMask EOAs use RFC 6979 deterministic signing so a pass is expected, but the check exists precisely because expectation is not evidence, and smart/MPC wallets can fail it.
5. **EIP-2612 permit: SUPPORTED. EIP-3009 also SUPPORTED (new finding, better than hoped).** `DOMAIN_SEPARATOR()` returns a live value, `nonces()` responds, `PERMIT_TYPEHASH()` equals the canonical EIP-2612 hash, and a garbage-signature `permit()` call reverts with `ECRecover: invalid signature` (the selector exists and executes). Additionally, `transferWithAuthorization()` reverts with `FiatTokenV2: authorization is expired` and `authorizationState()` responds: Arc's USDC implements Circle's FiatTokenV2 interface, so **EIP-3009 transfer-with-authorization is available too**. Consequence: single-transaction atomic flows are possible on both sides. A payer can sign one EIP-712 authorization and a periphery contract can execute transfer + announcement atomically in one transaction; a claim periphery can move stealth funds and `depositFor` in one transaction without a prior approve. Design Phases 3 and 4 assuming EIP-3009 periphery contracts, with the two-transaction flows as fallback.

### Phase 1: Payroll contract + minimal execution path

**What:** `SplitPayroll.sol` with full Forge test suite (per-payee try/catch fallback, residue return, cap enforcement, reentrancy, gas snapshots), deploy script, testnet deployment. A deliberately minimal UI: paste/enter a payee list, approve, execute one chunk, see outcomes. Migration `002_payroll.sql`.
**Why first:** it is the highest-risk artifact (moves the most money) with zero dependency on anything else, and every later payroll piece builds on its interface. Building UI polish before the contract's failure semantics are locked is backwards.
**Done when:** a testnet run pays a mixed list (Split users with hold + auto-send buckets, broken-bucket users hitting the fallback path, plain addresses) in one transaction, with every outcome visible in events, and gas per payee measured within Phase 0's cap.
**Stack:** Solidity 0.8.24 + OZ + Foundry (all existing patterns).

#### Phase 1 findings (built on branch `feat/payroll-privacy`, not merged)

- **Delivered (new files only, zero edits to any tracked file):** `contracts/src/SplitPayroll.sol` (runtime 2,555 bytes), `contracts/test/SplitPayroll.t.sol` (17 tests, 100% line/statement/branch/function coverage on the contract), `contracts/test/SplitPayrollFork.t.sol` (real-facade fork probe, self-skips without `ARC_RPC_URL`), `contracts/script/DeployPayroll.s.sol`, and `contracts/.gas-snapshot`. Full suite: 63 passed, 2 skipped (the fork probes), 0 failed. Existing 46-test `Split.t.sol` unaffected.
- **Contract shape matches the spec exactly:** `runPayroll(Payee[] calldata, uint256 runId)` with `Payee = {address dest, uint128 amount, bool isSplitUser, bytes32 memoHash}`, pull-total-once, per-payee `try Split.depositFor` with plain-transfer fallback, per-payee `PayrollPayment` outcome events (0 split / 1 fallback / 2 plain) plus `PayrollRun`, stateless, no owner, `nonReentrant`, allowance zeroed and residue returned at the end, hard `MAX_PAYEES` cap. `Split.sol` is referenced only through a minimal `ISplit` interface and is never touched.
- **The real-facade benchmark could not be run under a local fork (verified finding).** Arc's USDC facade at `0x3600...` is a proxy whose `transferFrom` delegates to an implementation that staticcalls an Arc system precompile at `0x1800...0001` (selector `0x8e204c43`). Forge's local EVM does not implement Arc's custom precompiles, so any USDC movement reverts under fork (`StackUnderflow`). This is a fork limitation, not a contract bug; it is now documented in a dedicated test.
- **Real cost was instead bounded with live on-chain anchors (Arc Testnet):** `eth_estimateGas` for a real facade transfer = 49,097 gas cold / 43,045 warm (top-level, so ~22-28k internal marginal, only modestly above a plain ERC-20, i.e. the precompile call is cheap); a real facade `approve` = 56,373; and one real memo-wrapped `depositFor` with a full multi-bucket split cost 140,774 gas end-to-end (includes the 21k base tx and memo-wrapper overhead payroll does not have). Together these bound the true per-Split-payee cost at roughly **90-130k gas**. The mock structural benchmark is ~55k/payee (3-bucket); the real figure is ~1.5-2x that, as expected.
- **`MAX_PAYEES = 100` confirmed safe.** At a conservative 130k gas/payee, a full 100-payee run is ~13M gas plus run overhead, roughly **40-45% of Arc's 30M block gas limit**, comfortable margin. The cap stands.
- **Two items are genuinely deferred, not skipped:** (1) **Testnet deployment** requires a funded deployer key, which is a human-side manual step (`DeployPayroll.s.sol` is written and compiles; run it with `forge script … --account <deployer> --broadcast` and env `USDC_ADDRESS`/`SPLIT_ADDRESS`). Nothing in this build handles a private key. (2) The **definitive end-to-end gas confirmation** is one real 100-payee `runPayroll` on testnet after that deployment; the on-chain anchors above make the cap safe to build on in the meantime, but that single real run is the final proof and is not yet done.
- **Security review (money-handling contract):** reentrancy guarded and test-proven against a malicious token; arithmetic overflow-safe (0.8 + uint128 into uint256, bounded by cap); no lingering allowance; no funds retained between calls; no owner/admin surface; no secrets anywhere. One documented, self-limiting limitation: a payee who maliciously configures their own buckets to exhaust the gas forwarded to `depositFor` could force a run to revert (griefing only their own payment; the employer controls the roster and Phase 2 pre-validation surfaces bad configs). Optional future hardening: forward a bounded gas stipend to `depositFor`. Not a Phase 1 blocker.

### Phase 2: Roster, verification gate, and reconciliation (payroll becomes a product)

**What:** Full roster CRUD with **pinned addresses**, signature-authed `app/api/payroll/*` routes, batch resolution + Multicall3 bucket pre-validation, the mandatory diff-and-confirm gate (hard block on changed addresses), chunked execution with run records and resume, `payroll-index` cron, activity feed integration ("Payroll from {employer}"), per-payee memo hashes, CSV export of runs.
**Why second:** all of it consumes Phase 1's interface, and the brief's required pre-send verification (#3) belongs before any real employer relies on the feature, so it ships in the same release as the roster, not after.
**Done when:** the brief's payroll story works end to end on testnet: enter roster once, run twice, second run flags nothing, a deliberately changed payee address hard-blocks until re-confirmed, and both sides' activity feeds read correctly.
**Stack:** existing Next.js 15 / wagmi / Supabase patterns throughout. Nothing new.

#### Phase 2 findings (built on branch `feat/payroll-privacy`, not merged)

- **Delivered (new files, plus two flagged existing-file touches):** migration `002_payroll.sql` (4 tables + RLS deny-public + payroll cursor row + a partial unique index guaranteeing one in-flight run per payroll + a documented post-deploy seed for the `@payroll` handle); `lib/payroll.ts` (pure logic) with `lib/payroll.test.mjs` (15 tests, all passing); `lib/payroll-session.ts` + `lib/payroll-server.ts` (stateless signed-session auth, ownership loaders, Multicall roster resolver); 8 API routes under `app/api/payroll/*`; the `payroll-index` reconciliation cron; `hooks/use-payroll.ts`; and the UI (`app/app/payroll/page.tsx` + `components/payroll/run-dialog.tsx`). The two touched existing files are the app-shell nav link and `vercel.json` cron entry, both named in §4.4. The no-touch indexer route, `Split.sol`, `lib/contracts.ts`/`arc.ts`/`bps.ts`, and every existing route are untouched (`git diff HEAD` shows only those two files).
- **Option 1 chosen (per instruction):** the `@payroll` handle is registered via a documented post-deploy `profiles` seed (in `002_payroll.sql`), so a recipient's existing activity feed resolves the sender as `@payroll` with zero edits to the no-touch activity route. The fuller recipient-side label was explicitly left as a separate future decision.
- **The confirm gate is enforced server-side, not just in the UI.** `POST /runs` re-resolves the whole roster, rebuilds the diff, and hard-blocks (409) on any changed/unresolved address regardless of client input; soft changes require an explicit `acknowledge`. The server is the sole source of truth for destinations (resolved from pinned addresses), so the client can never inject a payee address; it only signs the employer's own wallet transactions.
- **No fund custody anywhere in the stack.** Execution is always the employer's wallet (approve once, then one `runPayroll` per chunk of 50). The server prepares calldata and records the run/items before execution; the `SCHEDULER_PRIVATE_KEY` and every server key stay far away from payroll, per §7.7.
- **Reconciliation is order-based and exact:** the indexer matches on-chain `PayrollPayment` events to run items by `(chunk_run_id, item_index)`, valid because only `PayrollRun`/`PayrollPayment` come from the SplitPayroll address and the contract emits payments in payee-array order. A run flips to `completed` when every chunk fully reconciles.
- **Verification:** `next build` compiles all 8 routes + the cron + the page with lint and full type-checking green; `tsc --noEmit` clean; 15/15 pure-logic tests pass; Phase 1's 63 contract tests still pass. A live wallet-connected E2E of the execute flow needs a funded wallet and the deployed SplitPayroll (the Phase 1 manual step), so it is not run here; the gate, resolution, chunking, and reconciliation logic are covered by unit tests and the type/build checks in the meantime.
- **Code review (`/code-review`, local mode): no CRITICAL or HIGH findings.** Fixed during review: CSV formula-injection neutralization in the run export, and the concurrency backstop index above. Known/accepted: the large-roster Multicall issues 2×N reads in one call (fine for realistic rosters; paginate before pushing the 1000 cap); 500 responses surface raw Supabase `error.message`, kept consistent with every existing route in the repo rather than diverging one module.

### Phase 3: Stealth receive (privacy mode, no auto-split)

**What:** `lib/stealth.ts` (SDK-backed), stealth setup in profile (derive keys, publish meta-address to Registry + `stealth_meta` table), `StealthPayGateway.sol` with its Forge tests and testnet deployment, `stealth-pay-form.tsx` implementing the decided payer flow (compute stealth address, one EIP-712 `receiveWithAuthorization` signature, one atomic gateway transaction that pulls, forwards, and announces), `stealth-index` cron, client-side view-tag scanning against the announcements table, a "private balance" view listing detected stealth payments. No claiming yet beyond "send to an address you control."
**Why third, not parallel with 1:** depends on Phase 0's deployments and duality answer; shares the resolution surface Phase 2 hardened; and it is the phase with real cryptographic novelty, so it deserves a stabilized foundation and full attention. It also ships standalone user value: private receiving for individuals, before payroll integration.
**Done when:** wallet A pays wallet B's pay link in privacy mode; nothing on-chain or in the public activity table links the payment to B; B's client (and only B's client) detects and displays it; a fresh browser re-derives keys and finds the same payments.
**Stack:** @scopelift/stealth-address-sdk + viem. Scanning stays client-side (Bottleneck 6, Solution A).

#### Phase 3 findings (built on branch `feat/payroll-privacy`, not merged)

- **Delivered (new files, plus one flagged existing-file touch):** the ERC-5564 Announcer and ERC-6538 Registry vendored verbatim into `contracts/src/vendor/` (only the pinned `0.8.23` pragma bumped to `^0.8.23` to compile under the repo's 0.8.24, confirmed by diff); `StealthPayGateway.sol` (struct-param `payStealth`: atomic EIP-3009 `receiveWithAuthorization` pull + forward to stealth address + announce) with `StealthPayGateway.t.sol` (real EIP-3009 signing mock, 8 tests: happy path, replay, only-payee-can-execute, wrong-payee-sig, validity window, zero guards, reentrancy); `DeployStealth.s.sol`; `lib/stealth.ts` (SDK-wrapped key derivation, payer stealth-address generation, EIP-712 auth builder, view-tag scanning) and `lib/stealth-contracts.ts` (env-gated addresses, pinned USDC EIP-712 domain, ABIs verbatim from forge output); the `stealth_meta` + `announcements` migration `003_stealth.sql`; `stealth-index` cron; three `app/api/stealth/*` routes (signature-authed register, public lookup, public paginated announcements); `hooks/use-stealth.ts` (in-memory-only keys, sign-twice determinism guard, on-chain + off-chain publish, local scanning); `stealth-pay-form.tsx`; and the `/app/privacy` setup + scanning UI. The one flagged existing-file touch is the pay page (`app/pay/[handle]/page.tsx`) conditionally rendering the stealth form; the non-stealth path is preserved verbatim.
- **The SDK is the audited authority for all curve math** (`@scopelift/stealth-address-sdk`), wrapped never re-implemented, per the plan. Its typed API was verified from its declarations; it runs client-side in the browser bundle (it uses directory imports that only bundlers resolve, so no server route imports it, verified). The live crypto round-trip (pay to a fresh stealth address, detect by scanning, re-derive keys) is the Phase 3 browser E2E, which needs the deployed Announcer + a wallet, a manual step.
- **Key management follows Bottleneck 7:** stealth keys derive deterministically from one fixed, versioned keygen-message signature; spending keys are held in memory only, never persisted or transmitted; and setup double-signs to reject any wallet with non-deterministic signatures before funds can be stranded.
- **Privacy-preserving by construction:** announcements are indexed publicly and the recipient's client downloads and filters them locally with the view tag + viewing key, so the server never learns which announcements belong to whom.
- **Verification:** all contracts build; 73 tests pass, 0 failed (46 existing + 17 SplitPayroll + 8 StealthPayGateway + 2 fork skipped); `tsc --noEmit` clean; `next build` green with all stealth routes, the `/app/privacy` page, and the forked pay page compiling and the SDK bundling client-side. Deploy of the Announcer/Registry/Gateway is a funded-key manual step (`DeployStealth.s.sol` ready).
- **Code review (`/code-review`, local mode): no CRITICAL, HIGH, or MEDIUM findings.** The gateway's EIP-3009 flow, the signature-authed register route, the RLS, and the client key handling all reviewed clean. Fixed during review: an emoji and several em dashes in authored comments/copy (style only). Considered and rejected: adding `require(v==27||v==28)` to the gateway (USDC's `receiveWithAuthorization` is the authoritative signature verifier; a redundant check there could wrongly reject signatures the token accepts).

#### Phase 3 findings (built on branch `feat/payroll-privacy`, not merged)

- **Delivered.** Contracts: `ERC5564Announcer.sol` + `ERC6538Registry.sol` vendored verbatim into `contracts/src/vendor/` (byte-identical to ScopeLift's `forge install` source, only the fixed `pragma 0.8.23` bumped to `^0.8.23` to compile under the repo's 0.8.24); `StealthPayGateway.sol` (the atomic EIP-3009 pull + forward + announce) with `StealthPayGateway.t.sol` (10 tests, real EIP-3009 signature flow, all passing) and `DeployStealth.s.sol`. Client: `lib/stealth-contracts.ts` (ABIs + address getters + the verified USDC domain), `lib/stealth.ts` (SDK-wrapped crypto), `hooks/use-stealth.ts`. Off-chain: `003_stealth.sql`, `app/api/stealth/*` (register/lookup/announcements), `app/api/cron/stealth-index`. UI: `app/app/privacy/page.tsx` (enable + private-balance scan) and `app/pay/[handle]/stealth-pay-form.tsx`, plus the pay-page fork. Config touches: app-shell nav, `vercel.json` cron, `.env.example`.
- **All curve math is the audited SDK's, never hand-rolled** (design doc §4.2). The SDK's exact API was confirmed from its type declarations (key derivation, meta-address, stealth-address generation, `checkStealthAddress` scanning with the view-tag fast reject, scheme id 1), and the meta-address format question was resolved from the SDK source: `parseStealthMetaAddressURI` accepts the raw `0x` meta-address `generateStealthMetaAddressFromSignature` returns, so the wiring is correct.
- **The USDC EIP-712 domain was verified, not assumed.** The payer signs `ReceiveWithAuthorization` under a domain that must exactly match USDC's on-chain `DOMAIN_SEPARATOR` or the gateway pull reverts. Computed candidates against the live value confirm **name "USDC", version "2", chainId 5042002, verifyingContract 0x3600...**, pinned in `lib/stealth-contracts.ts`.
- **The gateway's front-running protection is test-proven.** `receiveWithAuthorization` requires the caller to be the payee, so only the gateway can execute a given payer signature; the suite verifies a different caller and a signature over a different `to` both revert, plus replay, validity windows, zero guards, and reentrancy. The gateway holds no funds (pull equals forward).
- **Key handling honors Bottleneck 7.** Stealth keys are derived from a versioned, never-to-change signing message, held in-memory only (never persisted or transmitted; the register route stores only the public meta-address), and a double-sign determinism check at enable blocks wallets whose signatures aren't reproducible.
- **Privacy is structural.** Scanning is fully client-side: the announcements endpoint is public and returns everything; the client filters locally with its viewing key, so the server never learns which announcements belong to whom.
- **Two deferred, flagged manual steps** (both need a funded key, human side): deploy the Announcer/Registry/Gateway with `DeployStealth.s.sol`, then set `NEXT_PUBLIC_STEALTH_*` + `STEALTH_DEPLOY_BLOCK` and run `003_stealth.sql`. Nothing in this build handles a private key.
- **Verification:** `next build` green (3 stealth routes + cron + privacy page + enlarged pay page, lint + full type-check); `tsc --noEmit` clean; 10/10 gateway tests pass; the full contract suite still passes (73 total). The **live crypto round-trip** (pay privately, detect, re-derive on a fresh browser) is the Phase 3 "Done when" E2E and requires the deployed Announcer + a funded wallet, so it is not run here; the SDK API, the EIP-712 domain, and the gateway signature flow are all verified in the meantime. The SDK's directory-style imports run under webpack (the client bundle) but not raw Node, so `lib/stealth.ts` is strictly client-side.
- **Scope boundary held:** detection + display + re-derivation only. No claiming (Quick/Private Claim route through buckets) is built; that is Phase 4, per "no claiming yet beyond send-to-an-address-you-control." Announcement metadata is the view tag only; the optional encrypted note is a later enhancement.
- **Code review (`/code-review`, local): no CRITICAL or HIGH.** Fixed during the build: tightened meta-address validation, a scan-loop page cap, and encoded path params. Noted: the SDK pulls transitive deps with `npm audit` advisories (client-only, pinned); scanning downloads all announcements and filters locally (fine at testnet volume; the view-tag reject keeps per-item cost low).

### Phase 4: Claim-and-split + payroll × privacy integration

**What:** Quick Claim (stealth address approves, then `Split.depositFor(mainAddress, amount)`, full bucket routing) first; Private Claim (client-computed shares, direct transfers per bucket destination) second with its correlation caveat in the UI; payroll roster gains "pay privately" per payee (payroll run computes stealth addresses for opted-in payees, transfers + announces inside the batch, requiring a small `SplitPayroll` v2 with an announce hook, re-tested and redeployed); disclosure copy for the salary-histogram limitation (Bottleneck 10, Solution A).

Two payroll-specific findings that belong in this phase's spec, stated explicitly:

- **The Private Claim wallet-reuse caveat applies identically to private payroll.** When a contractor opts into private payroll pay and later routes a payout to a wallet that has ever been used for ordinary Split activity (or any other public activity), that payout inherits the destination wallet's entire existing exposure. This is not a new problem introduced by payroll; it is the same Bottleneck 4 caveat in a new context, and the contractor-facing UI must say so at opt-in, not just at claim time.
- **"Private payroll" only ever means hidden from everyone except the employer running it.** The employer already knows who is on the roster and what each person is paid; stealth addresses change nothing about that. What stealth buys the contractor is privacy from *outside observers*: other clients, other contractors, chain analysts, anyone reading the block explorer. No copy, doc, or pitch should let anyone read "private payroll" as "invisible to the employer too."

**Why last:** it composes everything and is pure integration risk; nothing else waits on it. Claim UX decisions also benefit from real Phase 3 usage.
**Done when:** the full brief scenario runs on testnet: an employer pays a mixed roster in one action, stealth-enabled payees receive unlinkably, one tap claims a stealth payment through the payee's buckets, and each claim mode's privacy consequence is stated in the UI at the moment of choice.

#### Phase 4 findings (built on branch `feat/payroll-privacy`, not merged)

- **Claim side (new files):** `lib/claim-math.ts` (pure share math mirroring `_split`'s floor-division-plus-remainder rule, 8 unit tests including conservation) and `lib/stealth-claim.ts` (the Quick Claim and Private Claim executors, plus stealth-key derivation via the SDK); `components/stealth/claim-dialog.tsx` (mode chooser that states each mode's privacy consequence at the moment of choice); and the claim wiring in `hooks/use-stealth.ts` + the `/app/privacy` page. Both modes are app-signed with the computed stealth key (zero wallet popups); the key exists only transiently in memory.
- **The Arc gas model is handled explicitly.** A stealth address's USDC balance *is* its native gas (one pot, 10^12 decimal factor), so a claim can never move the full balance. Quick Claim approves, re-reads the balance, estimates `depositFor` gas with a 2x margin, and claims the remainder; Private Claim reserves for the worst-case transfer count, then distributes. A mid-sequence Private Claim failure leaves the remainder at the stealth address, re-scannable and re-claimable, so funds are never stranded.
- **Payroll × privacy (new + extended):** `SplitPayrollV2.sol` adds a per-payee private mode (transfer to a one-time stealth address + ERC-5564 announce) alongside the split/plain modes, with 8 Forge tests (mixed run, private outcome, fallback isolation, reverts, reentrancy) and `DeployPayrollV2.s.sol`. Migration `004` adds the `pay_private` opt-in and a run-item `mode` column. The run flow now targets V2: the server determines each payee's mode and hands private payees' public meta-addresses to the client, which computes the one-time stealth address on the employer's device (the server never does client crypto); the roster gains a private toggle, a private badge, and the required disclosures.
- **Disclosures, all present:** each claim mode's consequence in the claim dialog; the salary-histogram / amount-transparency limitation in the pay form and privacy page; and, for private payroll, the two required caveats in the roster banner: it is hidden from outside observers but **not from the employer**, and it only protects a contractor who routes the funds to a wallet they keep private (the wallet-reuse caveat).
- **Reconciliation is unaffected by privacy:** the indexer matches on-chain `PayrollPayment` events to run items by `(chunk_run_id, item_index)` ordinal, so a private payee's event logging the stealth address (not the real payee) still reconciles to the correct item, whose stored `payee_dest` remains the real contractor for the employer's private record.
- **Verification:** all contracts build; **81 tests pass, 0 failed** (46 + 17 SplitPayroll + 8 StealthPayGateway + 8 SplitPayrollV2 + 2 fork skipped); 23 pure-function tests pass (8 claim-math + 15 payroll); `tsc --noEmit` clean; `next build` green. Deploying the Announcer/Registry/Gateway and SplitPayrollV2 (and running migrations 003/004) are the funded-key + SQL manual steps; the live claim/private-payroll round-trips are the browser E2E that needs those deployments.
- **Code review (`/code-review`, local mode): no CRITICAL, HIGH, or MEDIUM findings.** The gas math, mode routing, reconciliation, and key handling reviewed clean. Fixed during review: two em dashes in authored comments (style). Considered and rejected: three flags on `SplitPayrollV2` (the try/catch fallback delivers to the same payee, not a wrong one; logging the stealth address in private mode is the privacy requirement, not an audit gap; and `nonReentrant` plus the trusted immutable announcer already cover reentrancy). Note: SplitPayroll V1 is now superseded by V2 in the run flow but retained as a standalone artifact.

### Continuous (not a phase): hardening gates

Forge test suite green + gas snapshots on every contract change; the repo's standing pre-push gates; Codex review on every phase's diffs; and before any real-money/mainnet payroll: a professional audit of `SplitPayroll` and the claim flows, plus the activity-retention fix already noted in [001_initial.sql:118-121](supabase/migrations/001_initial.sql).

---

## 7. What You're Missing (things neither the brief nor the questions covered)

**7.1 Arc might make stealth dramatically easier than anywhere else, verify it first.** On every mainstream EVM chain, the hardest part of stealth addresses is not cryptography, it is that a fresh stealth EOA holding only tokens has no ETH for gas, forcing relayer infrastructure (Umbra runs one). On Arc, gas *is* USDC. If a stealth address that received ERC-20 USDC can spend from its own balance for gas (Phase 0, spike 2), the entire relayer problem, the hardest operational piece of every existing stealth system, disappears. This is potentially the strongest technical argument for building this feature on Arc specifically, and it is worth one afternoon of verification before anything else. If it is false, Phase 3 needs a relayer design and its estimate grows materially.

**7.2 The database is the real root of trust, and payroll raises the stakes.** Split's on-chain layer is careful, but pay-link resolution is a mutable Supabase row behind a service-role key (Section 1.1). Today the blast radius of a bad row is one misdirected payment that a human payer might catch. Payroll multiplies it by the roster size and removes the human glance per payee. Address pinning (Bottleneck 8) is the mitigation inside this plan's scope; the bigger observation is that as Split grows payer-side features, the handle registry drifts toward being critical financial infrastructure, and eventually deserves an on-chain or signature-anchored source of truth (the ERC-6538 Registry from Phase 3 is a natural candidate, sign handle claims with the owning wallet).

**7.3 Salary amounts are the payroll privacy problem stealth does not solve.** Detailed in Bottleneck 10. One payroll tx publishes the full salary histogram forever, stealth or not. Decide the disclosure language now, not after an employer asks why their comp bands are on a block explorer.

**7.4 Compliance posture deserves a sentence before the code exists.** Two separate flags. Payroll: batch disbursement tooling sits near money-transmission and employment-payment regulation once real organizations pay real contractors; testnet now, but the marketing language ("payroll") creates expectations, and contractors will ask for receipts and year-end totals regardless (the memo hashes and CSV export in Phase 2 are the cheap version; build them from day one, they double as the compliance story). Privacy: EIP-5564 is transparent-amount and per-recipient, far milder than mixers, but "privacy payments" plus "payroll" in one product will eventually get a compliance question from a partner or exchange; the honest limitation paragraph already in the brief is the right instinct, keep it in user-facing copy.

**7.5 Handle lifecycle is unfinished business that payroll turns into a vulnerability.** If handles can be changed or abandoned (profiles schema permits handle updates), the old handle becomes claimable and every pay link and roster entry pointing at it silently redirects. Independent of payroll, consider: handles immutable once set, or a cooldown/tombstone on released handles. With payroll, pinning (Bottleneck 8) covers rosters, but printed/shared pay links remain exposed.

**7.6 Employer-side operational realities the brief skips.** Small, cheap to add early, expensive to retrofit: run approval as a two-step (prepare vs. execute) so a second person can review at organizations that have one; a per-run idempotency key wired through `runId` into events so a nervous double-click can never double-pay (the run-record model in Phase 2 provides this, keep it mandatory); and a paused/disabled state per payee, because "temporarily skip this contractor" is the most common roster edit there is.

**7.7 The scheduler hot key is fine for its current job and must not grow.** `SCHEDULER_PRIVATE_KEY` in a Vercel env var is acceptable for executing users' pre-authorized scheduled sends of their own held balances. It must never sign anything payroll-related or custody anything (Section 4.5, item 4). Worth writing down as a standing constraint now, before convenience suggests otherwise.

**7.8 Recipient-side product gap: incoming raw transfers still bypass buckets.** Payroll's fallback path (broken bucket config) and all non-Split flows deliver USDC straight to the wallet, unsplit, invisible to Split's activity feed. A small "deposit from wallet into my buckets" nudge (detect USDC balance at the main address, offer one-tap `deposit()`) closes the loop for every fallback payment payroll will ever produce, and it is nearly free to build: the contract function already exists.

**7.9 Deferred: a confidential-transfer tier (amount privacy). Distinct from stealth, explicitly not in scope for Phases 0 through 4.** Everything in this plan hides *who received* a payment; nothing in it hides *how much* was sent, and Bottleneck 10 shows payroll makes the amount leak worse, not better. A future third tier, confidential transfers that hide amounts (encrypted-balance schemes, or whatever amount-privacy primitives Arc itself may eventually ship at the protocol level), is the only real answer to that. It is logged here as a separate, later consideration on purpose: it is a different cryptographic problem with a different threat model, it must not be allowed to blur the honest scope of the stealth work (identity privacy only), and nothing in Phases 0 through 4 should take a dependency on it. Revisit only after stealth ships and only if Arc's roadmap or a vetted standard makes amounts hideable without homemade cryptography.

**7.10 Deferred: one-popup private payments via a relayer. Explicitly not in this build, logged so it is not silently forgotten.** The decided payer flow (Section 4.3) is two interactions: one `receiveWithAuthorization` signature plus one transaction the payer submits to `StealthPayGateway`. Because EIP-3009 authorizations are executable by whoever holds the signature-designated payee's call path, the second interaction can be removed entirely: a Split-operated relayer key submits the gateway transaction carrying the payer's signed authorization, and the payer's whole experience collapses to a single signature popup, zero transactions, gas paid by the relayer (about 0.001 USDC per payment at observed fees). The relayer cannot steal or redirect funds: it can only execute exactly what the payer signed, with amount, gateway, and validity window pinned inside the authorization. It is deferred anyway because it adds a liveness dependency (relayer down means private payments down), an operational hot key that needs funding, rate limits, and monitoring, and a censorship surface, none of which the v1 needs. Revisit after Phase 4 ships if payer-side friction proves to be a real adoption problem rather than a hypothetical one.

---

## Post-review hardening: chunked-run resume/reconcile (built, closes the one flagged functional gap)

The four phase reviews each flagged the same real gap: a payroll run larger than one chunk (>50 payees) that fails mid-way could double-pay the chunks that already landed if the employer simply started a new run. That is now closed.

- **Server:** the run-creation guard treats an `executing` OR `partial` run as resumable (409 `resumable` with its `runRef`), so a fresh run can never be created over an unfinished one. The run-detail route now also returns each item's `mode`, so private payees can be rebuilt on resume.
- **Client (run dialog):** on open, an unfinished run takes precedence and the dialog offers **Resume** or **Cancel**. Resume pays *only the chunks that have not landed*: a chunk counts as landed if the indexer already reconciled it OR its recorded tx hash confirms `status: success` on-chain, so a confirmed chunk is never re-sent. Each chunk's tx hash is now recorded *on submit* (before awaiting the receipt), closing the crash-between-broadcast-and-record window that could otherwise lose a landed chunk. Private payees are rebuilt with a freshly computed stealth address reusing the stored `chunk_run_id`, so reconciliation still matches. Cancel abandons the run (marked `failed`) behind an explicit confirmation that already-paid batches are not reversed.
- **Verification:** `tsc` clean, `next build` green. The live resume round-trip (deliberately fail a multi-chunk run, reopen, resume) is part of the post-deploy browser E2E, since it needs a wallet, a >50-payee roster, and the deployed contracts.
