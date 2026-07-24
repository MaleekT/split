// Unit tests for lib/claim-math.ts. Run: node --test lib/claim-math.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeClaimPlan, claimTransferCount } from './claim-math.ts'

const ZERO = '0x0000000000000000000000000000000000000000'
const A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const B = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb'

function b(bps, destination, active = true) { return { bps, destination, active } }

test('auto-send only: exact split, no remainder', () => {
  const plan = computeClaimPlan([b(6000, A), b(4000, B)], 100n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 60n }, { destination: B, amount: 40n }])
  assert.equal(plan.toMainAddress, 0n)
})

test('hold + auto-send: hold share routed to main address', () => {
  const plan = computeClaimPlan([b(6000, ZERO), b(4000, A)], 100n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 40n }])
  assert.equal(plan.toMainAddress, 60n)
})

test('floor remainder goes to the LAST hold bucket (mirrors _split)', () => {
  // 33.33 / 33.33 / 33.34 -> floors 33/33/33, remainder 1 to last hold (idx 2)
  const plan = computeClaimPlan([b(3333, ZERO), b(3333, A), b(3334, ZERO)], 100n)
  // holds: bucket0 = 33, bucket2 = 33 + 1 remainder = 34  => main gets 67
  assert.equal(plan.toMainAddress, 67n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 33n }])
  // conservation: everything adds back to the input
  const total = plan.autoSends.reduce((a, t) => a + t.amount, 0n) + plan.toMainAddress
  assert.equal(total, 100n)
})

test('no hold bucket: remainder is not lost, routed to main', () => {
  const plan = computeClaimPlan([b(3333, A), b(3333, B), b(3334, A)], 100n)
  // shares 33/33/33 = 99, remainder 1 -> main (no hold bucket to absorb it)
  assert.equal(plan.toMainAddress, 1n)
  const total = plan.autoSends.reduce((a, t) => a + t.amount, 0n) + plan.toMainAddress
  assert.equal(total, 100n)
})

test('conservation holds for a large realistic amount', () => {
  const amount = 700_000_000n // 700 USDC
  const plan = computeClaimPlan([b(6000, ZERO), b(3000, A), b(1000, ZERO)], amount)
  const total = plan.autoSends.reduce((a, t) => a + t.amount, 0n) + plan.toMainAddress
  assert.equal(total, amount)
  assert.equal(plan.autoSends.length, 1)              // one auto-send bucket
  assert.equal(plan.toMainAddress, 420_000_000n + 70_000_000n) // 60% + 10% holds
})

test('zero-value shares produce no transfer', () => {
  // tiny amount where a 1-bps bucket floors to 0
  const plan = computeClaimPlan([b(9999, A), b(1, B)], 5n)
  // 5*9999/10000 = 4 (floor), 5*1/10000 = 0 -> B share is 0, skipped; remainder 1 -> no hold -> main
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 4n }])
  assert.equal(plan.toMainAddress, 1n)
})

test('inactive buckets are ignored', () => {
  const plan = computeClaimPlan([b(6000, A), b(4000, B, false)], 100n)
  assert.deepEqual(plan.autoSends, [{ destination: A, amount: 60n }])
  // 40% bucket inactive -> its 40 becomes unallocated remainder -> main
  assert.equal(plan.toMainAddress, 40n)
})

test('claimTransferCount counts auto-sends plus a main transfer when present', () => {
  assert.equal(claimTransferCount(computeClaimPlan([b(6000, ZERO), b(4000, A)], 100n)), 2)
  assert.equal(claimTransferCount(computeClaimPlan([b(6000, A), b(4000, B)], 100n)), 2)
  assert.equal(claimTransferCount(computeClaimPlan([b(10000, A)], 100n)), 1)
})
