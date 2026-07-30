// Allocation arithmetic for the Add Bucket flow.
// Run: node --test lib/allocation.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bpsToFree, canAbsorbReduction, BPS_TOTAL } from './allocation.ts'

test('nothing to free when there is already room', () => {
  assert.equal(bpsToFree(8_000, 1_500), 0)
  assert.equal(bpsToFree(0, 10_000), 0)
})

test('exactly filling to 100% frees nothing', () => {
  // The boundary that matters: the contract allows sum == 10000, only > reverts.
  assert.equal(bpsToFree(8_500, 1_500), 0)
})

test('a full roster must free the whole new allocation', () => {
  // The reported case: buckets already at 100%, new bucket wants 15%.
  assert.equal(bpsToFree(BPS_TOTAL, 1_500), 1_500)
})

test('partially full roster frees only the overflow', () => {
  // 90% used, asking for 25% -> only the 15% overflow needs freeing.
  assert.equal(bpsToFree(9_000, 2_500), 1_500)
})

test('never returns a negative amount', () => {
  assert.equal(bpsToFree(1_000, 1_000), 0)
})

test('non-finite input frees nothing rather than propagating NaN', () => {
  // pctStr is free text, so parseFloat can yield NaN. Returning NaN here would
  // make the comparison silently false and let an over-allocation reach the
  // contract, which is the failure this whole check exists to prevent.
  assert.equal(bpsToFree(NaN, 1_500), 0)
  assert.equal(bpsToFree(BPS_TOTAL, NaN), 0)
})

test('a bucket larger than the requirement can absorb it', () => {
  assert.equal(canAbsorbReduction(4_000, 1_500), true)
})

test('a bucket exactly equal to the requirement cannot', () => {
  // Reducing it to 0% would be a deletion, which pays out its balance. Never
  // done implicitly.
  assert.equal(canAbsorbReduction(1_500, 1_500), false)
})

test('a bucket smaller than the requirement cannot', () => {
  assert.equal(canAbsorbReduction(1_000, 1_500), false)
})

test('the 34/33/33 case: no single bucket covers 50%', () => {
  // Documents the limitation the popup surfaces rather than hides.
  const buckets = [3_400, 3_300, 3_300]
  assert.equal(buckets.some((b) => canAbsorbReduction(b, 5_000)), false)
})

test('the common case: the largest bucket covers a modest new allocation', () => {
  const buckets = [6_000, 3_000, 1_000]
  assert.equal(buckets.some((b) => canAbsorbReduction(b, 1_500)), true)
})
