// Unit tests for lib/claim-math.ts. Run: node --test lib/claim-math.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeClaimPlan, claimTransferCount, claimReserveRaw, isDustAmount } from './claim-math.ts'

const ZERO = '0x0000000000000000000000000000000000000000'
const A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const B = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb'
const VAULT = '0x5555555555555555555555555555555555555555'
// Stands in for the user's public main address, which must NEVER receive a
// transfer from a Private Claim.
const MAIN = '0x9999999999999999999999999999999999999999'

function b(bps, destination, active = true) { return { bps, destination, active } }

// Everything the plan moves, plus everything it deliberately leaves behind, must
// always add back up to the input. Nothing is created or lost.
function conserved(plan, amount) {
  const sent = plan.autoSends.reduce((a, t) => a + t.amount, 0n)
  return sent + plan.deferredRaw === amount
}

test('auto-send only: exact split, nothing deferred', () => {
  const plan = computeClaimPlan([b(6000, A), b(4000, B)], 100n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 60n }, { destination: B, amount: 40n }])
  assert.equal(plan.deferredRaw, 0n)
  assert.ok(conserved(plan, 100n))
})

test('hold + auto-send WITHOUT a Vault: hold share is deferred, not sent', () => {
  const plan = computeClaimPlan([b(6000, ZERO), b(4000, A)], 100n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 40n }])
  assert.equal(plan.deferredRaw, 60n)
  assert.ok(conserved(plan, 100n))
})

test('hold + auto-send WITH a Vault: hold share is routed to the Vault', () => {
  const plan = computeClaimPlan([b(6000, ZERO), b(4000, A)], 100n, VAULT)
  assert.deepEqual(plan.autoSends, [
    { destination: A, amount: 40n },
    { destination: VAULT, amount: 60n },
  ])
  assert.equal(plan.deferredRaw, 0n)
  assert.ok(conserved(plan, 100n))
})

test('floor remainder goes to the LAST hold bucket (mirrors _split)', () => {
  // 33.33 / 33.33 / 33.34 -> floors 33/33/33, remainder 1 to last hold (idx 2)
  const plan = computeClaimPlan([b(3333, ZERO), b(3333, A), b(3334, ZERO)], 100n)
  // holds: bucket0 = 33, bucket2 = 33 + 1 remainder = 34 => 67 deferred
  assert.equal(plan.deferredRaw, 67n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 33n }])
  assert.ok(conserved(plan, 100n))
})

test('floor remainder follows the hold portion into the Vault', () => {
  const plan = computeClaimPlan([b(3333, ZERO), b(3333, A), b(3334, ZERO)], 100n, VAULT)
  assert.deepEqual(plan.autoSends, [
    { destination: A, amount: 33n },
    { destination: VAULT, amount: 67n },
  ])
  assert.equal(plan.deferredRaw, 0n)
  assert.ok(conserved(plan, 100n))
})

test('no hold bucket: remainder is deferred, never invented as a transfer', () => {
  const plan = computeClaimPlan([b(3333, A), b(3333, B), b(3334, A)], 100n)
  // shares 33/33/33 = 99, remainder 1 -> no hold bucket to absorb it
  assert.equal(plan.deferredRaw, 1n)
  assert.ok(conserved(plan, 100n))
})

test('no hold bucket, with a Vault: remainder goes to the Vault', () => {
  const plan = computeClaimPlan([b(3333, A), b(3333, B), b(3334, A)], 100n, VAULT)
  assert.equal(plan.deferredRaw, 0n)
  assert.deepEqual(plan.autoSends.at(-1), { destination: VAULT, amount: 1n })
  assert.ok(conserved(plan, 100n))
})

test('conservation holds for a large realistic amount', () => {
  const amount = 700_000_000n // 700 USDC
  const plan = computeClaimPlan([b(6000, ZERO), b(3000, A), b(1000, ZERO)], amount)
  assert.ok(conserved(plan, amount))
  assert.equal(plan.autoSends.length, 1)                          // one auto-send bucket
  assert.equal(plan.deferredRaw, 420_000_000n + 70_000_000n)      // 60% + 10% holds
})

test('a 100%-hold roster with no Vault sends nothing at all', () => {
  // The exact shape that previously pushed the whole payment to the main wallet.
  const plan = computeClaimPlan([b(10000, ZERO)], 1_000_000n)
  assert.deepEqual(plan.autoSends, [])
  assert.equal(plan.deferredRaw, 1_000_000n)
  assert.equal(claimTransferCount(plan), 0)
})

test('a 100%-hold roster with a Vault sends everything to the Vault', () => {
  const plan = computeClaimPlan([b(10000, ZERO)], 1_000_000n, VAULT)
  assert.deepEqual(plan.autoSends, [{ destination: VAULT, amount: 1_000_000n }])
  assert.equal(plan.deferredRaw, 0n)
})

// Regression guard for the bug this change exists to fix: a Private Claim once
// sent hold-bucket funds to the user's public main address (observed live, tx
// 0x0209a7905cac). No roster shape may ever produce a transfer there again.
test('REGRESSION: the main address never receives a transfer, in any shape', () => {
  const rosters = [
    [b(10000, ZERO)],
    [b(6000, ZERO), b(4000, A)],
    [b(3333, ZERO), b(3333, A), b(3334, ZERO)],
    [b(3333, A), b(3333, B), b(3334, A)],
    [b(9999, A), b(1, B)],
    [b(6000, A), b(4000, B, false)],
  ]
  for (const roster of rosters) {
    for (const vault of [null, VAULT]) {
      const plan = computeClaimPlan(roster, 1_000_000n, vault)
      for (const t of plan.autoSends) {
        assert.notEqual(t.destination.toLowerCase(), MAIN.toLowerCase())
      }
      assert.ok(conserved(plan, 1_000_000n), 'value must be conserved')
    }
  }
})

test('zero-value shares produce no transfer', () => {
  // tiny amount where a 1-bps bucket floors to 0
  const plan = computeClaimPlan([b(9999, A), b(1, B)], 5n)
  // 5*9999/10000 = 4 (floor), 5*1/10000 = 0 -> B share is 0, skipped; remainder 1
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 4n }])
  assert.equal(plan.deferredRaw, 1n)
})

test('inactive buckets are ignored', () => {
  const plan = computeClaimPlan([b(6000, A), b(4000, B, false)], 100n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 60n }])
  // 40% bucket inactive -> its 40 becomes unallocated remainder -> deferred
  assert.equal(plan.deferredRaw, 40n)
})

test('claimTransferCount counts only real transfers; deferred funds cost no gas', () => {
  // No Vault: the hold portion moves nothing, so only the auto-send is charged.
  assert.equal(claimTransferCount(computeClaimPlan([b(6000, ZERO), b(4000, A)], 100n)), 1)
  // With a Vault: the hold portion becomes one extra transfer.
  assert.equal(claimTransferCount(computeClaimPlan([b(6000, ZERO), b(4000, A)], 100n, VAULT)), 2)
  assert.equal(claimTransferCount(computeClaimPlan([b(6000, A), b(4000, B)], 100n)), 2)
  assert.equal(claimTransferCount(computeClaimPlan([b(10000, A)], 100n)), 1)
})

// ── Dust threshold ────────────────────────────────────────────────────────────

test('claimReserveRaw converts gas cost to 6-decimal USDC units', () => {
  // 510k gas * 20 gwei * 2 margin = 2.04e16 wei; /1e12 = 20400 raw = 0.0204 USDC
  assert.equal(claimReserveRaw(20_000_000_000n), 20_400n)
})

test('claimReserveRaw scales with gas price', () => {
  const cheap = claimReserveRaw(10_000_000_000n)
  const dear  = claimReserveRaw(40_000_000_000n)
  assert.equal(dear, cheap * 4n)
})

test('the real stranded dust is classified as dust', () => {
  // Observed on Arc: 2116 raw units left at a stealth address by a prior claim's
  // gas reservation, rendered as "0.00 USDC" with a live Claim button.
  const reserve = claimReserveRaw(28_867_614_720n) // real observed gas price
  assert.equal(isDustAmount(2_116n, reserve), true)
})

test('a 5 USDC payment is not dust', () => {
  const reserve = claimReserveRaw(28_867_614_720n)
  assert.equal(isDustAmount(5_000_000n, reserve), false)
})

test('amount exactly equal to the reserve is dust, matching the executor guard', () => {
  // quickClaim throws on `balanceWei <= reserve`, so equality must be dust or the
  // UI would offer a Claim the executor refuses.
  const reserve = claimReserveRaw(20_000_000_000n)
  assert.equal(isDustAmount(reserve, reserve), true)
  assert.equal(isDustAmount(reserve + 1n, reserve), false)
})
