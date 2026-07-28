# Split: Private Vault and Private Claim routing

Companion to [FEASIBILITY-PAYROLL-PRIVACY.md](FEASIBILITY-PAYROLL-PRIVACY.md).
Covers Steps 1-3 and 7-9 of the Private Vault work. Steps 4-6 are deferred; see
[Deferred work](#deferred-work).

Branch: `feat/payroll-privacy`. Nothing merges to master without explicit approval.

---

## 1. Why this exists

Private Claim used to send the hold-bucket portion of a payment to the user's
**main wallet**.

Verified live on Arc Testnet: claiming a 1.00 USDC private payment sent
**0.995237 USDC to `0x448F...57AF`** (tx `0x0209a7905cac`, block 54071551). The
funds were never lost, but they left the private path and landed at the user's
public identity. That is a partial deanonymisation of the exact payment the
private path exists to protect, and the UI did not make it obvious: the success
message read *"The payment was distributed to your buckets directly"* even though
100% went to the wallet and no bucket received anything.

The Private Vault gives that portion somewhere to land that is still the user's,
but is not their public identity.

---

## 2. Step 0 findings (read-only audit, before any code)

### Phase status from the original plan
All four phases are built and verified end-to-end on Arc Testnet:

| Phase | Status |
|---|---|
| 1 - SplitPayroll batch disbursement | Complete, deployed, full contract test coverage |
| 2 - payroll indexer cron | Complete |
| 3 - EIP-5564 stealth (Announcer / Registry / Gateway) | Complete, deployed, **proven live** end to end |
| 4 - SplitPayrollV2 private payroll mode | Complete, deployed |

Post-review work also landed: run resume/reconcile, dust threshold, Claim all,
opaque private-link token, indexer span fix, RPC retry/backoff.

### What Private Claim did
`privateClaim` reserved gas for the **worst-case** transfer count and then claimed
`(balance - reserve)` in full. `computeClaimPlan` mirrored `Split._split`
(`share_i = floor(amount * bps_i / 10000)`, floor remainder to the last hold
bucket), routed auto-send shares to their destinations, and aggregated every hold
share into `toMainAddress`.

**Partial claims were not supported.** All-or-nothing.

### Was the fallback still present?
Yes, at `lib/claim-math.ts` (hold shares and the floor remainder both accumulated
into `toMainAddress`). Documented in code comments and in the claim dialog copy,
but effectively silent in the UI.

### No-touch conflicts
Steps 4-6 required five files still at **master state**, two of which wrap
functions on the no-touch list (`add-bucket-modal.tsx` -> `addBucket`,
`withdraw-modal.tsx` -> `withdraw`), plus `bucket-card.tsx`,
`edit-bucket-modal.tsx` and `app/app/page.tsx`. Flagged before starting;
**Steps 4-6 were deferred** rather than worked around.

**No contract change was needed.** `Bucket.destination` is an arbitrary address
(`address(0)` = hold), so a Vault is simply an address funds are sent to.
`contracts/` is untouched and nothing was redeployed.

---

## 3. What was built

### Step 1 - Partial claims
`ClaimPlan` now returns `deferredRaw`: the hold portion that has nowhere
legitimate to go. `privateClaim` sends only transfers that have a real
destination, and sizes its gas reserve to the **actual** transfer count rather
than the worst case, so a partial claim is cheaper than a full one.

Deferred funds stay at the stealth address, are re-detected by the next scan, and
become claimable once a Vault exists. `PrivateClaimResult.deferredRaw` reports
this so the UI can state it rather than imply everything was distributed.

### Step 2 - Private Vault
`lib/vault.ts`. Deterministic key derived from an **EIP-712 typed-data**
signature, so the same wallet always produces the same Vault and it is recoverable
on any device by signing again.

### Step 3 - Hold portions route to the Vault
`computeClaimPlan(buckets, amount, vaultAddress | null)`:
- Vault present -> hold shares plus floor remainder become one transfer to the Vault.
- Vault absent -> they become `deferredRaw` and are **not sent**.
- **`toMainAddress` was removed entirely**, not bypassed.

Quick Claim is unaffected: it deposits into the Split contract, which handles hold
buckets natively on-chain.

### Step 7 - Deliberate consolidation
`sweepVaultToMain` plus a "Move to main wallet" action on the Privacy page. Never
automatic, never the default. It sits behind an explicit confirmation stating that
this action publicly links the Vault to the main wallet and, because the Vault is
one reused address, can retroactively expose everything it has ever received.

### Step 8 - Copy
The Private Claim mode description no longer says hold funds "land at your main
address". The success screen reports what actually moved and names what stayed
behind. The Vault card states plainly that it is a reused persistent address by
design, that this is a real improvement rather than anonymity, and that Split can
derive the key to spend from it - which is what makes claiming seamless and also
means it lacks the separate confirmation step a standalone wallet app provides.

---

## 4. Decisions

### The Vault address is never stored (deviation from the approved plan)
The approved plan called for a `private_vaults` table and migration `006`. While
building it, storing the mapping was found to be a **privacy leak in its own
right**: the Vault is the address that receives the user's claimed private income,
so anyone who learns the `main address -> Vault address` mapping can watch it and
reconstruct the amounts and timing of every private claim. That recreates, in our
own records, the exact link this work removes.

This is unlike `stealth_meta`, which is public for good reason: a meta-address
reveals nothing about which stealth addresses are the user's without their viewing
key.

**Decision: derive client-side, store nothing.** No table, no migration, no API
route. The address lives in session memory and is re-derived by signing.

Consequences, accepted deliberately:
- The Privacy page shows the Vault only after unlocking, matching how Scan already
  works.
- Cross-session drift in a wallet's signing behaviour cannot be detected, because
  there is no durable reference to compare against. The sign-twice determinism
  check at unlock is what covers the realistic failure mode.
- The question of migration `006` failing loudly is now moot: there is no
  migration to forget.

### HARD RULE: the Vault never leaves the client
Written into `lib/vault.ts` as an enforceable comment, not only documented here.
The Vault address and key must never be logged, transmitted, or persisted outside
the browser session: no server storage, no request body or query string, no
console logging, no error-reporting or analytics payload, no `localStorage`.
Session memory only. The private key is held to the same standard as the stealth
spending key.

### EIP-712 for the Vault, and what it does not buy
The Vault signs typed data rather than a plain message. Being precise about why:
**EIP-712 does not prevent replay-phishing.** A malicious site can request the
byte-identical payload and receive the byte-identical signature; the domain
separator is requester-chosen data, not bound to the requesting origin by the
wallet. The benefit is presentational - structured fields, a visible name and
chainId, stronger wallet warnings - which reduces blind-signing. Risk 1 below is
**not** retired by it, and the UI does not imply otherwise.

### The Vault domain is its own
`VAULT_EIP712_DOMAIN` is `{ name: 'Split Private Vault', version: '1', chainId }`
with **no `verifyingContract`**. It deliberately does not reuse
`USDC_EIP712_DOMAIN` (`{ name: 'USDC', version: '2', chainId, verifyingContract }`),
which signs EIP-3009 `ReceiveWithAuthorization` - real fund-moving
authorisations. Sharing a domain between "prove it's me" and "move my USDC" is one
careless struct addition away from cross-protocol replay, even though differing
type hashes keep the digests apart today.

### Determinism is checked on the typed-data path
Unlocking signs the same payload **twice** and compares. A wallet that signs
non-deterministically would derive a different Vault later and strand whatever was
sent to the first one, so this runs before any funds can be routed there. This
matters more for typed data, not less: `signTypedData` handling varies more across
wallets and smart accounts than `personal_sign`.

Before spending, `assertVaultAddressMatches` re-derives the address from the
cached key and refuses to act unless it matches. Free, and it catches a changed
derivation **before** funds move rather than after.

---

## 5. Risks, stated plainly

1. **Derivation blast radius.** One signature derives the Vault key. Anyone who
   induces that signature can drain the Vault. EIP-712 does not fix this.
2. **Determinism is mandatory.** Wallets with non-deterministic signatures (some
   smart-account/AA wallets) cannot support a Vault. Detected and refused rather
   than silently stranding funds.
3. **Wallet loss = Vault loss.** Recovery requires the same wallet signing the
   same payload. There is no other path.
4. **Persistent address = pattern.** Repeated use of one Vault address is
   correlatable over time. A real improvement over paying yourself in the open,
   not anonymity.
5. **Consolidation is irreversible as disclosure.** Moving Vault funds to the main
   wallet links them publicly and cannot be un-linked afterwards.

---

## 6. Files

**Modified (all branch-owned):**
- `lib/claim-math.ts` - `deferredRaw`, Vault routing, `toMainAddress` removed
- `lib/claim-math.test.mjs` - updated and extended
- `lib/stealth-claim.ts` - partial claims, actual-count gas reserve, `sweepVaultToMain`
- `hooks/use-stealth.ts` - Vault unlock, preview, balance, consolidation
- `app/app/privacy/page.tsx` - Vault card, consolidation, copy
- `components/stealth/claim-dialog.tsx` - Vault prompt, honest outcome copy

**New:**
- `lib/vault.ts`, `lib/vault.test.mjs`
- `PRIVATE-VAULT-AND-WALLETS.md`

**Left alone, deliberately:**
`components/add-bucket-modal.tsx`, `components/withdraw-modal.tsx`,
`components/bucket-card.tsx`, `components/edit-bucket-modal.tsx`,
`app/app/page.tsx`, `contracts/**` (no change, no redeploy), `lib/contracts.ts`,
`lib/arc.ts`, `lib/bps.ts`, and every master-state route under `app/api/`.

No database migration. No new API route. No environment variable.

---

## 7. Deferred work

### Steps 4-6: per-bucket generated wallets, spending from them, Total Balance
Deferred because they require the five master-state bucket and dashboard files
above, two of which wrap no-touch contract calls. To be scoped as their own
reviewable change.

When scoped, the agreed shape for Total Balance: show the full sum, with a
breakdown separating provably-controlled funds (hold-in-contract, Vault, generated
wallets) from money already sent to external, manually-added addresses - so the
figure is complete without conflating money the user controls with money they have
already paid away.

### Retrofitting stealth-key derivation to EIP-712

**Revisit trigger: before mainnet, or before stealth addresses see meaningful real
usage, whichever comes first.**

The reason for a hard trigger rather than an open-ended "later": the cost of this
migration scales with the number of live stealth addresses and published
meta-addresses. It is cheap today only because usage is testnet dust. That stops
being true the moment either trigger fires, and it only ever gets more expensive
to postpone.

Why it is not a swap: changing the signing method changes the signature, hence the
derived keys, hence the published meta-address. A correct migration needs dual
derivation, scanning announcements with both old and new viewing keys, sweeping
funds from old stealth addresses to new, and re-registering on-chain (ERC-6538)
and off-chain. The stale meta-address remains in the registry, so anyone with a
cached pay link keeps paying the old scheme - dual-scanning must persist for a
long deprecation window. Live dust already exists at `0x8972...` and `0x055E...`,
so a careless rotation strands real funds. It buys only the presentational benefit
described in section 4.

---

## 8. Verification

- `node --test lib/claim-math.test.mjs lib/vault.test.mjs` - **33 passing**.
  Covers Vault routing, deferral without a Vault, value conservation in both
  modes, derivation determinism and stability, rejection of under-length
  signatures, domain separation, and both guards.
- A dedicated regression test asserts that **no roster shape, with or without a
  Vault, ever produces a transfer to the main address** - the bug this work fixes.
- `npx tsc --noEmit` clean; `npm run build` clean.
- Still to run on the preview: claim a payment into a 100%-hold roster and confirm
  on-chain that funds land at the **Vault** and never at the main wallet, the
  inverse of tx `0x0209a7905cac`; and claim with no Vault, confirming the hold
  portion stays at the stealth address and is re-detected by the next scan.
