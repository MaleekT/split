// Pure-function unit tests for lib/payroll.ts.
//
// Written as .mjs so it is NOT matched by tsconfig's `**/*.ts` include (it never
// enters the Next build type-check) while Node 24 still runs it directly with
// native TypeScript type-stripping on the imported module. Zero new deps.
//
// Run: node --test lib/payroll.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUnits, keccak256, toHex, zeroHash } from 'viem'
import {
  parseUsdcAmount,
  runTotalRaw,
  computeMemoHash,
  chunk,
  makeBaseRunId,
  chunkRunId,
  planChunks,
  toPayrollArg,
  diffPayee,
  buildRunDiff,
  hasBlockingChanges,
  requiresConfirmation,
} from './payroll.ts'

const A = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa'
const B = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb'

// ── parseUsdcAmount ───────────────────────────────────────────────────────────

test('parseUsdcAmount: whole and fractional', () => {
  assert.equal(parseUsdcAmount('100'), 100_000_000n)
  assert.equal(parseUsdcAmount('0.5'), 500_000n)
  assert.equal(parseUsdcAmount('0.000001'), 1n)
  assert.equal(parseUsdcAmount('  12.34  '), 12_340_000n)
})

test('parseUsdcAmount: rejects bad input', () => {
  assert.throws(() => parseUsdcAmount(''))
  assert.throws(() => parseUsdcAmount('abc'))
  assert.throws(() => parseUsdcAmount('-1'))
  assert.throws(() => parseUsdcAmount('0'))
  assert.throws(() => parseUsdcAmount('1e5'))
  assert.throws(() => parseUsdcAmount('1.2345678')) // > 6 decimals
})

test('runTotalRaw sums', () => {
  assert.equal(runTotalRaw([1n, 2n, 3n]), 6n)
  assert.equal(runTotalRaw([]), 0n)
})

// ── computeMemoHash ───────────────────────────────────────────────────────────

test('computeMemoHash: empty maps to zero hash', () => {
  assert.equal(computeMemoHash(''), zeroHash)
  assert.equal(computeMemoHash('   '), zeroHash)
})

test('computeMemoHash: deterministic keccak of trimmed text', () => {
  assert.equal(computeMemoHash('July salary'), keccak256(toHex('July salary')))
  assert.equal(computeMemoHash('  July salary  '), keccak256(toHex('July salary')))
})

// ── chunk ─────────────────────────────────────────────────────────────────────

test('chunk: uneven, exact, empty', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
  assert.deepEqual(chunk([], 3), [])
  assert.throws(() => chunk([1], 0))
})

// ── run-id derivation ─────────────────────────────────────────────────────────

test('makeBaseRunId is a numeric string', () => {
  assert.match(makeBaseRunId(1_700_000_000_000), /^\d+$/)
  assert.equal(makeBaseRunId(1_700_000_000_000), '1700000000000')
})

test('chunkRunId derives unique ids', () => {
  assert.equal(chunkRunId('1700', 0), '1700000')
  assert.equal(chunkRunId('1700', 3), '1700003')
  assert.notEqual(chunkRunId('1700', 1), chunkRunId('1700', 2))
  assert.throws(() => chunkRunId('1700', 1000))
  assert.throws(() => chunkRunId('1700', -1))
  assert.throws(() => chunkRunId('nope', 0))
})

test('planChunks maps index, runId, items', () => {
  const args = Array.from({ length: 5 }, (_, i) =>
    toPayrollArg(A, BigInt(i + 1), false, zeroHash),
  )
  const plan = planChunks(args, '1700', 2)
  assert.equal(plan.length, 3)
  assert.equal(plan[0].chunkIndex, 0)
  assert.equal(plan[0].runId, '1700000')
  assert.equal(plan[0].items.length, 2)
  assert.equal(plan[2].items.length, 1)
  assert.equal(plan[2].runId, '1700002')
})

// ── diff gate ─────────────────────────────────────────────────────────────────

function payee(over = {}) {
  return { id: 'p1', label: 'Ada', handle: 'ada', pinnedAddress: A, amountRaw: '700000000', isSplitUser: true, active: true, ...over }
}

test('diffPayee: unresolved handle is blocking', () => {
  const d = diffPayee(payee(), { id: 'p1', resolvedAddress: null, isSplitUser: false }, undefined)
  assert.equal(d.kind, 'unresolved')
  assert.equal(d.blocking, true)
})

test('diffPayee: address change is blocking (Bottleneck 8)', () => {
  const d = diffPayee(payee(), { id: 'p1', resolvedAddress: B, isSplitUser: true }, undefined)
  assert.equal(d.kind, 'address_changed')
  assert.equal(d.blocking, true)
})

test('diffPayee: new payee needs confirmation, not blocking', () => {
  const d = diffPayee(payee(), { id: 'p1', resolvedAddress: A, isSplitUser: true }, undefined)
  assert.equal(d.kind, 'new')
  assert.equal(d.requiresConfirmation, true)
  assert.equal(d.blocking, false)
})

test('diffPayee: amount change needs confirmation', () => {
  const prev = { payeeDest: A, amountRaw: '600000000', label: 'Ada' }
  const d = diffPayee(payee(), { id: 'p1', resolvedAddress: A, isSplitUser: true }, prev)
  assert.equal(d.kind, 'amount_changed')
  assert.equal(d.requiresConfirmation, true)
  assert.equal(d.blocking, false)
})

test('diffPayee: unchanged is silent', () => {
  const prev = { payeeDest: A, amountRaw: '700000000', label: 'Ada' }
  const d = diffPayee(payee(), { id: 'p1', resolvedAddress: A, isSplitUser: true }, prev)
  assert.equal(d.kind, 'unchanged')
  assert.equal(d.requiresConfirmation, false)
  assert.equal(d.blocking, false)
})

test('buildRunDiff + aggregates', () => {
  const payees = [
    payee({ id: 'p1', pinnedAddress: A, amountRaw: '700000000' }),
    payee({ id: 'p2', pinnedAddress: B, amountRaw: '500000000', handle: 'bayo' }),
  ]
  const resolutions = new Map([
    ['p1', { id: 'p1', resolvedAddress: A, isSplitUser: true }],
    ['p2', { id: 'p2', resolvedAddress: '0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc', isSplitUser: true }], // moved!
  ])
  const previous = new Map([[A, { payeeDest: A, amountRaw: '700000000', label: 'Ada' }]])
  const diff = buildRunDiff(payees, resolutions, previous)
  assert.equal(diff[0].kind, 'unchanged')
  assert.equal(diff[1].kind, 'address_changed')
  assert.equal(hasBlockingChanges(diff), true)
  assert.equal(requiresConfirmation(diff), false)
})
