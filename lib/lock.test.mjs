import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PENALTY_BPS, penaltyFor, quotePenalty, isDustWithdrawal,
  isUnlocked, previewWithdraw, secondsUntilUnlock, remainingToTarget,
  validateUnlockDate, MIN_LOCK_DURATION_SECONDS,
} from './lock.ts'

const NOW  = 1_800_000_000n
const YEAR = 31_536_000n
const state = (o = {}) => ({
  unlockAt:  NOW + YEAR,
  target:    0n,
  targetMet: false,
  balance:   0n,
  ...o,
})

// ── Penalty arithmetic: mirrors BucketLock's table exactly ───────────────────

test('penalty is exactly 10%, fixed', () => {
  assert.equal(PENALTY_BPS, 1_000n)
  assert.equal(penaltyFor(100_000_000n), 10_000_000n)
})

test('penalty rounds UP, not down', () => {
  // 10% of 15 is 1.5 -> 2, never 1.
  assert.equal(penaltyFor(15n), 2n)
  assert.equal(penaltyFor(11n), 2n)
  assert.equal(penaltyFor(10n), 1n)
})

test('ceiling guarantees a non-zero penalty for every amount >= 1', () => {
  for (let a = 1n; a <= 40n; a++) {
    assert.ok(penaltyFor(a) >= 1n, `amount ${a} produced a zero penalty`)
  }
})

test('one raw unit is dust: penalty consumes it entirely', () => {
  assert.equal(penaltyFor(1n), 1n)
  assert.ok(isDustWithdrawal(1n))
  assert.equal(isDustWithdrawal(2n), false)
})

test('quotePenalty is a calculator, not a gate: no dust throw', () => {
  assert.deepEqual(quotePenalty(1n), { penalty: 1n, net: 0n })
  assert.deepEqual(quotePenalty(100n), { penalty: 10n, net: 90n })
})

test('quote is internally consistent for arbitrary amounts', () => {
  for (const a of [2n, 7n, 999n, 1_000_000n, 123_456_789n, 2n ** 200n]) {
    const { penalty, net } = quotePenalty(a)
    assert.equal(penalty + net, a, `not conserved at ${a}`)
    assert.ok(penalty <= a)
    if (a >= 2n) assert.ok(net > 0n, `net should be positive at ${a}`)
  }
})

test('penalty has no overflow ceiling, unlike the Solidity uint256 path', () => {
  const huge = 2n ** 255n
  assert.equal(penaltyFor(huge), (huge * 1_000n + 9_999n) / 10_000n)
})

// ── Unlock semantics ─────────────────────────────────────────────────────────

test('locked before the date', () => {
  assert.equal(isUnlocked(state(), NOW), false)
})

test('unlocks on the date, inclusive', () => {
  const s = state()
  assert.equal(isUnlocked(s, s.unlockAt - 1n), false)
  assert.equal(isUnlocked(s, s.unlockAt), true)
})

test('unlocks on live balance meeting target, without any latch', () => {
  const s = state({ target: 100n, balance: 100n, targetMet: false })
  assert.equal(isUnlocked(s, NOW), true)
})

test('one unit short of target stays locked', () => {
  assert.equal(isUnlocked(state({ target: 100n, balance: 99n }), NOW), false)
})

test('latch keeps it unlocked after the balance falls below target', () => {
  const s = state({ target: 100n, balance: 1n, targetMet: true })
  assert.equal(isUnlocked(s, NOW), true)
})

test('target of zero means date-only and never unlocks by balance', () => {
  const s = state({ target: 0n, balance: 10n ** 18n })
  assert.equal(isUnlocked(s, NOW), false)
})

// ── previewWithdraw mirrors every contract revert ────────────────────────────

test('preview rejects a zero amount', () => {
  assert.equal(previewWithdraw(state({ balance: 100n }), 0n, NOW).error, 'InvalidAmount')
})

test('preview rejects more than the balance', () => {
  assert.equal(previewWithdraw(state({ balance: 100n }), 101n, NOW).error, 'InsufficientBalance')
})

test('preview rejects a net-zero dust withdrawal', () => {
  const p = previewWithdraw(state({ balance: 100n }), 1n, NOW)
  assert.equal(p.error, 'PenaltyExceedsAmount')
})

test('early preview charges the ceiling penalty', () => {
  const p = previewWithdraw(state({ balance: 1_000_000n }), 1_000_000n, NOW)
  assert.deepEqual(p, { net: 900_000n, penalty: 100_000n, early: true, error: null })
})

test('unlocked preview charges nothing at all', () => {
  const s = state({ balance: 1_000_000n })
  const p = previewWithdraw(s, 1_000_000n, s.unlockAt)
  assert.deepEqual(p, { net: 1_000_000n, penalty: 0n, early: false, error: null })
})

test('a partial early withdrawal is penalised on the amount, not the principal', () => {
  const p = previewWithdraw(state({ balance: 1_000_000n }), 100_000n, NOW)
  assert.equal(p.penalty, 10_000n)
  assert.equal(p.net, 90_000n)
})

// ── Derived display values ───────────────────────────────────────────────────

test('secondsUntilUnlock counts down and then floors at zero', () => {
  const s = state()
  assert.equal(secondsUntilUnlock(s, NOW), YEAR)
  assert.equal(secondsUntilUnlock(s, s.unlockAt), 0n)
  assert.equal(secondsUntilUnlock(s, s.unlockAt + 1n), 0n)
})

test('remainingToTarget reports the shortfall, and zero once latched', () => {
  assert.equal(remainingToTarget(state({ target: 100n, balance: 40n })), 60n)
  assert.equal(remainingToTarget(state({ target: 100n, balance: 100n })), 0n)
  assert.equal(remainingToTarget(state({ target: 100n, balance: 0n, targetMet: true })), 0n)
  assert.equal(remainingToTarget(state({ target: 0n, balance: 0n })), 0n)
})

// ── Factory date validation, mirrored so the form fails before the wallet ────

test('a date is always required', () => {
  assert.equal(validateUnlockDate(0n, NOW), 'DateRequired')
})

test('a date inside the minimum duration is rejected, at the exact boundary', () => {
  assert.equal(validateUnlockDate(NOW + MIN_LOCK_DURATION_SECONDS - 1n, NOW), 'UnlockTooSoon')
  assert.equal(validateUnlockDate(NOW + MIN_LOCK_DURATION_SECONDS, NOW), null)
})
