// Private Vault derivation tests. Run: node --test lib/vault.test.mjs
//
// Node 24 runs TypeScript natively, so this imports lib/vault.ts directly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveVaultKey,
  deriveVaultAddress,
  assertDeterministicSignature,
  assertVaultAddressMatches,
  vaultTypedData,
  VAULT_EIP712_NAME,
} from './vault.ts'

// Arc Testnet. Injected rather than imported from lib/chain, which raw Node cannot
// resolve (extensionless relative import). tsc covers the real call site's wiring.
const CHAIN_ID = 5042002

// Two distinct, well-formed 65-byte signatures.
const SIG_A = '0x' + '11'.repeat(65)
const SIG_B = '0x' + '22'.repeat(65)

test('derivation is deterministic: same signature always yields the same key', () => {
  assert.equal(deriveVaultKey(SIG_A), deriveVaultKey(SIG_A))
  assert.equal(deriveVaultAddress(SIG_A), deriveVaultAddress(SIG_A))
})

test('derivation is stable across repeated calls (Vault is recoverable)', () => {
  const first = deriveVaultAddress(SIG_A)
  for (let i = 0; i < 5; i++) assert.equal(deriveVaultAddress(SIG_A), first)
})

test('different signatures derive different Vaults', () => {
  assert.notEqual(deriveVaultKey(SIG_A), deriveVaultKey(SIG_B))
  assert.notEqual(deriveVaultAddress(SIG_A), deriveVaultAddress(SIG_B))
})

test('derived key is a well-formed 32-byte private key', () => {
  const key = deriveVaultKey(SIG_A)
  assert.match(key, /^0x[0-9a-f]{64}$/)
})

test('derived address is a checksummed 20-byte address', () => {
  assert.match(deriveVaultAddress(SIG_A), /^0x[0-9a-fA-F]{40}$/)
})

// The security property the plan calls out: a truncated or stubbed signature must
// never seed a key, because it would be derivable by anyone.
test('rejects signatures shorter than 65 bytes', () => {
  assert.throws(() => deriveVaultKey('0x1'), /Invalid signature/)
  assert.throws(() => deriveVaultKey('0x' + '11'.repeat(64)), /Invalid signature/)
})

test('rejects non-hex input', () => {
  assert.throws(() => deriveVaultKey('not-a-signature'), /Invalid signature/)
  assert.throws(() => deriveVaultKey('0x' + 'zz'.repeat(65)), /Invalid signature/)
})

test('accepts a longer-than-65-byte signature (exotic wallets)', () => {
  assert.match(deriveVaultKey('0x' + '11'.repeat(80)), /^0x[0-9a-f]{64}$/)
})

// Domain separation. The Vault domain must never be confusable with USDC's
// EIP-3009 domain, which signs real fund-moving authorizations and is
// `{ name: 'USDC', version: '2', chainId, verifyingContract: USDC }`.
//
// Asserted on the Vault's own shape rather than by importing stealth-contracts.ts,
// whose transitive extensionless imports raw Node cannot resolve. These are the
// properties that actually provide the separation.
test('Vault domain carries no verifyingContract', () => {
  const domain = vaultTypedData(CHAIN_ID).domain
  // The decisive property: USDC's domain is bound to the USDC contract. A domain
  // with no verifyingContract can never collide with it.
  assert.equal('verifyingContract' in domain, false)
})

test('Vault domain name is not the USDC payment domain name', () => {
  assert.notEqual(VAULT_EIP712_NAME, 'USDC')
  assert.equal(vaultTypedData(CHAIN_ID).domain.name, VAULT_EIP712_NAME)
})

test('Vault typed data is a complete, self-consistent payload', () => {
  const td = vaultTypedData(CHAIN_ID)
  assert.equal(td.primaryType, 'Vault')
  assert.equal(td.domain.chainId, CHAIN_ID)
  // Every declared field is present in the message, or signTypedData would throw.
  for (const field of td.types.Vault) {
    assert.ok(field.name in td.message, `missing field: ${field.name}`)
  }
})

test('Vault signs a typed-data struct, unlike the stealth plain-string message', () => {
  // The stealth derivation signs a plain string via personal_sign; the Vault signs
  // a typed-data struct. Different signed byte formats, so the two derivations
  // cannot collide even if a wallet somehow produced the same signature bytes.
  assert.equal(typeof vaultTypedData(CHAIN_ID).message, 'object')
})

test('determinism guard rejects mismatched signatures', () => {
  assert.doesNotThrow(() => assertDeterministicSignature(SIG_A, SIG_A))
  assert.throws(() => assertDeterministicSignature(SIG_A, SIG_B), /different signatures/)
})

test('address-match guard is case-insensitive but rejects a real mismatch', () => {
  const addr = deriveVaultAddress(SIG_A)
  assert.doesNotThrow(() => assertVaultAddressMatches(addr, addr))
  assert.doesNotThrow(() => assertVaultAddressMatches(addr, addr.toLowerCase()))
  assert.throws(
    () => assertVaultAddressMatches(addr, deriveVaultAddress(SIG_B)),
    /no longer matches/,
  )
})
