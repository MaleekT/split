// Bucket wallet derivation tests. Run: node --test lib/bucket-wallet.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveBucketWalletKey,
  deriveBucketWalletAddress,
  recoverBucketWalletIndices,
  bucketWalletTypedData,
  BUCKET_WALLET_EIP712_NAME,
} from './bucket-wallet.ts'
import { deriveVaultAddress, vaultTypedData, VAULT_EIP712_NAME } from './vault.ts'

const SIG_A = '0x' + '11'.repeat(65)
const SIG_B = '0x' + '22'.repeat(65)
const CHAIN_ID = 5042002

test('same signature and index always derive the same address', () => {
  assert.equal(deriveBucketWalletAddress(SIG_A, 0), deriveBucketWalletAddress(SIG_A, 0))
  assert.equal(deriveBucketWalletAddress(SIG_A, 7), deriveBucketWalletAddress(SIG_A, 7))
})

test('index N and N+1 derive different addresses', () => {
  for (let i = 0; i < 5; i++) {
    assert.notEqual(deriveBucketWalletAddress(SIG_A, i), deriveBucketWalletAddress(SIG_A, i + 1))
  }
})

test('every index in a range is unique - no two buckets can share a wallet', () => {
  const seen = new Set()
  for (let i = 0; i < 64; i++) seen.add(deriveBucketWalletAddress(SIG_A, i))
  assert.equal(seen.size, 64)
})

test('different signatures derive different wallets at the same index', () => {
  assert.notEqual(deriveBucketWalletAddress(SIG_A, 3), deriveBucketWalletAddress(SIG_B, 3))
})

// Guards the delimiter choice: without it, index 1 then 23 and index 12 then 3
// could collapse to the same preimage.
test('index encoding is unambiguous (1|23 does not collide with 12|3)', () => {
  assert.notEqual(deriveBucketWalletKey(SIG_A, 123), deriveBucketWalletKey(SIG_A, 1231))
  assert.notEqual(deriveBucketWalletAddress(SIG_A, 12), deriveBucketWalletAddress(SIG_A, 123))
})

test('derived key is a well-formed 32-byte private key', () => {
  assert.match(deriveBucketWalletKey(SIG_A, 0), /^0x[0-9a-f]{64}$/)
})

test('rejects signatures shorter than 65 bytes', () => {
  assert.throws(() => deriveBucketWalletKey('0x1', 0), /Invalid signature/)
  assert.throws(() => deriveBucketWalletKey('0x' + '11'.repeat(64), 0), /Invalid signature/)
})

test('rejects invalid indices', () => {
  assert.throws(() => deriveBucketWalletKey(SIG_A, -1), /Invalid bucket wallet derivation index/)
  assert.throws(() => deriveBucketWalletKey(SIG_A, 1.5), /Invalid bucket wallet derivation index/)
  assert.throws(() => deriveBucketWalletKey(SIG_A, 999_999_999), /Invalid bucket wallet derivation index/)
})

// ── Domain separation: all three derivations must be mutually distinct ────────

test('bucket wallets never collide with the Vault, at any index', () => {
  const vault = deriveVaultAddress(SIG_A).toLowerCase()
  for (let i = 0; i < 64; i++) {
    assert.notEqual(deriveBucketWalletAddress(SIG_A, i).toLowerCase(), vault)
  }
})

test('bucket EIP-712 domain is distinct from the Vault domain and carries no verifyingContract', () => {
  assert.notEqual(BUCKET_WALLET_EIP712_NAME, VAULT_EIP712_NAME)
  assert.notEqual(BUCKET_WALLET_EIP712_NAME, 'USDC')
  const domain = bucketWalletTypedData(CHAIN_ID).domain
  assert.equal('verifyingContract' in domain, false)
  assert.notEqual(domain.name, vaultTypedData(CHAIN_ID).domain.name)
})

test('bucket typed data is a complete, self-consistent payload', () => {
  const td = bucketWalletTypedData(CHAIN_ID)
  assert.equal(td.primaryType, 'BucketWallets')
  assert.equal(td.domain.chainId, CHAIN_ID)
  for (const field of td.types.BucketWallets) {
    assert.ok(field.name in td.message, `missing field: ${field.name}`)
  }
})

// ── Recovery without the database ────────────────────────────────────────────

test('recovers indices for a dense set of destinations', () => {
  const indices = [0, 1, 2, 3]
  const destinations = indices.map((i) => deriveBucketWalletAddress(SIG_A, i))
  const { found, unresolved, hitBound } = recoverBucketWalletIndices(SIG_A, destinations, 64)
  assert.equal(found.length, indices.length)
  assert.deepEqual(unresolved, [])
  assert.equal(hitBound, false)
  for (const { address, index } of found) {
    assert.equal(address, deriveBucketWalletAddress(SIG_A, index))
  }
})

// The case a fixed 0..64 ceiling silently failed, and that an early-exit-on-misses
// heuristic ALSO failed: deleted buckets leave a long run of dead indices between
// live destinations, and the scan must not stop inside that gap.
test('recovers a bucket far beyond a large gap of burned indices', () => {
  const destinations = [deriveBucketWalletAddress(SIG_A, 0), deriveBucketWalletAddress(SIG_A, 90)]
  const { found, unresolved } = recoverBucketWalletIndices(SIG_A, destinations, 128)
  assert.equal(found.length, 2)
  assert.deepEqual(found.map((f) => f.index).sort((a, b) => a - b), [0, 90])
  assert.deepEqual(unresolved, [])
})

test('an unmatchable destination is reported as unresolved, never mislabelled', () => {
  const real  = deriveBucketWalletAddress(SIG_A, 1)
  const alien = '0xdeaDBeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF'
  const { found, unresolved, hitBound } = recoverBucketWalletIndices(SIG_A, [real, alien], 32)
  assert.equal(found.length, 1)
  assert.equal(found[0].address, real)
  // The decisive property: it comes back as unresolved, so the caller must say so
  // rather than silently rendering it as an ordinary pasted address.
  assert.deepEqual(unresolved, [alien])
  assert.equal(hitBound, true)
})

test('a wallet derived from a different signature is not falsely matched', () => {
  const other = deriveBucketWalletAddress(SIG_B, 2)
  const { found, unresolved } = recoverBucketWalletIndices(SIG_A, [other], 32)
  assert.deepEqual(found, [])
  assert.deepEqual(unresolved, [other])
})

test('a destination past the bound is unresolved, not absent', () => {
  const far = deriveBucketWalletAddress(SIG_A, 50)
  const { found, unresolved, hitBound } = recoverBucketWalletIndices(SIG_A, [far], 10)
  assert.deepEqual(found, [])
  assert.deepEqual(unresolved, [far])
  assert.equal(hitBound, true)
  // Raising the bound finds it, proving the bound was the limiting factor.
  assert.equal(recoverBucketWalletIndices(SIG_A, [far], 64).found[0].index, 50)
})

test('stops as soon as every destination is found', () => {
  // Index 0 with a bound of 0: reachable only if the loop exits on completion.
  const { found, hitBound } = recoverBucketWalletIndices(SIG_A, [deriveBucketWalletAddress(SIG_A, 0)], 0)
  assert.equal(found.length, 1)
  assert.equal(hitBound, false)
})

test('empty destination list returns immediately', () => {
  const { found, unresolved, hitBound } = recoverBucketWalletIndices(SIG_A, [])
  assert.deepEqual(found, [])
  assert.deepEqual(unresolved, [])
  assert.equal(hitBound, false)
})
