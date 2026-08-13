import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ZERO_ADDRESS, evaluateHoldInvariant, dustCatcherArgs,
  maxStrandedPerDeposit, DUST_CATCHER_BPS,
} from './hold-invariant.ts'

const WALLET = '0x1111111111111111111111111111111111111111'
const hold = (id, bps, active = true) => ({ id: BigInt(id), bps, destination: ZERO_ADDRESS, active })
const send = (id, bps, active = true) => ({ id: BigInt(id), bps, destination: WALLET, active })

test('a deposit-ready set with a hold bucket is OK', () => {
  const r = evaluateHoldInvariant([hold(1, 8_000), send(2, 2_000)])
  assert.equal(r.state, 'OK')
  assert.equal(r.totalBps, 10_000)
  assert.equal(r.hasHoldBucket, true)
})

test('an all-destination deposit-ready set is DEGRADED', () => {
  const r = evaluateHoldInvariant([send(1, 5_000), send(2, 5_000)])
  assert.equal(r.state, 'DEGRADED')
  assert.equal(r.hasHoldBucket, false)
})

test('mid-setup is INCOMPLETE, never a dust warning', () => {
  // This is the case that must NOT fire: _split reverts InvalidBPSTotal before
  // any rounding is reachable, so there is no dust to warn about.
  const r = evaluateHoldInvariant([send(1, 3_000)])
  assert.equal(r.state, 'INCOMPLETE')
})

test('an empty set is INCOMPLETE, not degraded', () => {
  assert.equal(evaluateHoldInvariant([]).state, 'INCOMPLETE')
})

test('converting the last hold bucket to a destination WOULD_STRAND', () => {
  const before = [hold(1, 8_000), send(2, 2_000)]
  const r = evaluateHoldInvariant(before, { upsert: send(1, 8_000) })
  assert.equal(r.state, 'WOULD_STRAND')
})

test('deleting the last hold bucket WOULD_STRAND only when the rest still total 100%', () => {
  // Removing an 8,000 bps hold bucket leaves 2,000: not deposit-ready, so
  // INCOMPLETE is the honest answer rather than a dust warning.
  const r1 = evaluateHoldInvariant([hold(1, 8_000), send(2, 2_000)], { remove: 1n })
  assert.equal(r1.state, 'INCOMPLETE')

  // Removing a ZERO-bps hold bucket leaves the others at exactly 100%.
  const r2 = evaluateHoldInvariant([hold(1, 0), send(2, 10_000)], { remove: 1n })
  assert.equal(r2.state, 'WOULD_STRAND')
})

test('adding the dust catcher repairs a degraded set without touching allocations', () => {
  const degraded = [send(1, 5_000), send(2, 5_000)]
  assert.equal(evaluateHoldInvariant(degraded).state, 'DEGRADED')

  const { bps, destination } = dustCatcherArgs()
  const repaired = evaluateHoldInvariant(degraded, {
    upsert: { id: 99n, bps, destination, active: true },
  })
  assert.equal(repaired.state, 'OK')
  // The whole point: it takes no allocation, so the existing split is untouched.
  assert.equal(bps, 0)
  assert.equal(repaired.totalBps, 10_000)
})

test('an INACTIVE hold bucket does not satisfy the invariant', () => {
  // _split only sets lastHoldIdx inside `if (b.active)`.
  const r = evaluateHoldInvariant([hold(1, 0, false), send(2, 10_000)])
  assert.equal(r.state, 'DEGRADED')
  assert.equal(r.hasHoldBucket, false)
})

test('an inactive bucket contributes no BPS', () => {
  const r = evaluateHoldInvariant([hold(1, 10_000), send(2, 9_999, false)])
  assert.equal(r.totalBps, 10_000)
  assert.equal(r.state, 'OK')
})

test('destination comparison is case-insensitive', () => {
  const upper = { id: 1n, bps: 10_000, destination: ZERO_ADDRESS.toUpperCase(), active: true }
  assert.equal(evaluateHoldInvariant([upper]).hasHoldBucket, true)
})

test('evaluating a change never mutates the caller array', () => {
  const before = [hold(1, 10_000)]
  const copy   = before.slice()
  evaluateHoldInvariant(before, { remove: 1n, upsert: send(2, 10_000) })
  assert.deepEqual(before, copy)
})

test('stranded dust is bounded by activeBuckets - 1', () => {
  assert.equal(maxStrandedPerDeposit(10), 9)   // MAX_BUCKETS
  assert.equal(maxStrandedPerDeposit(1), 0)
  assert.equal(maxStrandedPerDeposit(0), 0)
})

test('the dust catcher is a zero-bps hold bucket', () => {
  const a = dustCatcherArgs()
  assert.equal(a.bps, DUST_CATCHER_BPS)
  assert.equal(a.bps, 0)
  assert.equal(a.destination, ZERO_ADDRESS)
})
