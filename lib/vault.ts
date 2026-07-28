// Private Vault: a persistent, deterministically-derived address the user controls,
// used as the destination for the hold-bucket portion of a Private Claim.
//
// Why it exists: Private Claim used to push hold-bucket shares to the user's MAIN
// wallet, which partially deanonymised the very payment the private path protects.
// The Vault gives those funds somewhere to land that is still the user's, but is
// not their public identity.
//
// ── HARD RULE: the Vault address and key are CLIENT-ONLY ─────────────────────
//
// The derived Vault address must NEVER be logged, transmitted, or persisted
// anywhere outside the user's browser session. That means: no server storage, no
// API request body or query string, no console logging, no error-reporting or
// analytics payload, no localStorage. Session memory only.
//
// This is not a style preference, it is the feature's whole security property.
// The Vault receives the user's claimed private income. Anyone who learns the
// main-address -> Vault-address mapping can watch that address and reconstruct the
// amounts and timing of every private payment the user ever claims - which is
// precisely what the private path exists to prevent. Persisting the mapping would
// recreate, in our own records, the exact link this feature was built to remove.
//
// The private key is held to the same standard as the stealth spending key: it
// exists transiently in memory and is never written down anywhere.
//
// No wallet/SDK imports here on purpose: the derivation is pure and unit-testable.

// Imports are limited to `viem` on purpose. Like lib/claim-math.ts, this module
// stays free of relative project imports so it can be unit-tested directly under
// raw Node (`node --test`), which cannot resolve extensionless relative paths or
// the bundler-only ScopeLift SDK. chainId is therefore injected, not imported.
import { keccak256, concat, toBytes, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ── EIP-712 signing payload ───────────────────────────────────────────────────
//
// Deliberately its OWN domain. It must never reuse USDC_EIP712_DOMAIN
// (lib/stealth-contracts.ts), which carries `verifyingContract: USDC` and is used
// to sign EIP-3009 ReceiveWithAuthorization - real fund-moving authorizations.
// Sharing a domain between "prove it's me" and "move my USDC" is one careless
// struct addition away from cross-protocol replay, even though differing type
// hashes keep the digests apart today. No `verifyingContract` here: this signature
// authorises nothing on-chain, it only seeds a key.
//
// Also distinct by construction from STEALTH_KEYGEN_MESSAGE (lib/stealth.ts),
// which is a personal_sign payload - a different signed byte format entirely, so
// the stealth and Vault derivations cannot collide.
export const VAULT_EIP712_NAME    = 'Split Private Vault'
export const VAULT_EIP712_VERSION = '1'

export const VAULT_EIP712_TYPES = {
  Vault: [
    { name: 'purpose', type: 'string' },
    { name: 'version', type: 'string' },
  ],
} as const

export const VAULT_EIP712_MESSAGE = {
  purpose: 'Derive my Split Private Vault key. This signature never leaves my device.',
  version: VAULT_EIP712_VERSION,
} as const

/**
 * The exact payload to hand to signTypedData. Built in one place so the signing
 * call site and the tests cannot drift apart.
 *
 * Note the absence of `verifyingContract`: this signature authorises nothing
 * on-chain, and omitting it keeps the domain structurally incapable of being
 * confused with USDC's EIP-3009 payment-authorisation domain.
 */
export function vaultTypedData(chainId: number) {
  return {
    domain: {
      name:    VAULT_EIP712_NAME,
      version: VAULT_EIP712_VERSION,
      chainId,
    },
    types:       VAULT_EIP712_TYPES,
    primaryType: 'Vault' as const,
    message:     VAULT_EIP712_MESSAGE,
  }
}

// Domain tag mixed into the hash so the derived key is bound to this purpose even
// if an identical signature were ever produced under another scheme.
const VAULT_KEY_TAG = 'split.private-vault.v1'

// '0x' + 65 bytes (r,s,v) as hex = 2 + 130.
const MIN_SIGNATURE_LENGTH = 132

/**
 * Derive the Vault private key from the user's typed-data signature.
 * Deterministic: the same wallet signing the same payload always yields the same
 * key, which is what makes the Vault recoverable on any device.
 */
export function deriveVaultKey(signature: Hex): Hex {
  // A secp256k1 signature is 65 bytes (r,s,v) = 130 hex chars + the 0x prefix.
  // Reject anything shorter outright: a truncated or stubbed value would still
  // hash to a usable-looking key, but one seeded from almost no entropy, and the
  // resulting Vault would be trivially derivable by anyone. Longer values are
  // allowed so an exotic wallet returning extra data still works.
  if (!/^0x[0-9a-fA-F]+$/.test(signature) || signature.length < MIN_SIGNATURE_LENGTH) {
    throw new Error('Invalid signature for Vault derivation')
  }
  return keccak256(concat([toBytes(VAULT_KEY_TAG), toBytes(signature)]))
}

/** The Vault's address for a given signature. Pure; no network access. */
export function deriveVaultAddress(signature: Hex): `0x${string}` {
  return privateKeyToAccount(deriveVaultKey(signature)).address
}

/** The address a Vault private key controls. Used to re-verify before spending. */
export function vaultAddressFromKey(privateKey: Hex): `0x${string}` {
  return privateKeyToAccount(privateKey).address
}

/**
 * Guard against a wallet whose signatures are not deterministic. Such a wallet
 * would derive a different key on a later visit and strand the Vault permanently,
 * so this must run at creation, BEFORE any funds can be routed there.
 *
 * Applies to the typed-data path specifically: signTypedData handling varies more
 * across wallets and smart accounts than personal_sign, so the risk is higher
 * here, not lower.
 */
export function assertDeterministicSignature(sigA: Hex, sigB: Hex): void {
  if (sigA !== sigB) {
    throw new Error(
      'Your wallet produced different signatures for the same request, so a Private Vault could not be recovered later. Private Vault is not supported for this wallet.',
    )
  }
}

/**
 * Re-assert before spending that the derived key still controls the Vault address
 * we recorded. Costs nothing extra (no second signature) and catches a wallet that
 * silently changed signing behaviour after creation - before funds move, not after.
 */
export function assertVaultAddressMatches(derived: `0x${string}`, expected: `0x${string}`): void {
  if (derived.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      'The key derived from your wallet no longer matches your recorded Vault address. Nothing was moved. Reconnect the wallet that created this Vault.',
    )
  }
}
