// Client-side stealth-address crypto (ERC-5564, scheme 1 / secp256k1).
//
// Thin wrapper over @scopelift/stealth-address-sdk; all curve math lives in the
// audited SDK, never hand-rolled here. This module is CLIENT-ONLY: it runs in the
// browser bundle (payer flow, key setup, scanning). Server routes only ever
// handle the meta-address string, never these functions.

import {
  generateKeysFromSignature,
  generateStealthMetaAddressFromSignature,
  generateStealthAddress,
  checkStealthAddress,
  computeStealthKey,
  getViewTagFromMetadata,
  VALID_SCHEME_ID,
} from '@scopelift/stealth-address-sdk'
import { toHex } from 'viem'
import {
  USDC_EIP712_DOMAIN,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
} from './stealth-contracts'

/**
 * The fixed message a user signs to deterministically derive their stealth keys.
 *
 * IMPORTANT: THIS STRING MUST NEVER CHANGE. The user's spending and viewing keys are
 * derived from the signature over exactly this text; changing a single byte
 * derives different keys and permanently strands any funds sitting at stealth
 * addresses generated from the old keys. Version it instead of editing.
 */
export const STEALTH_KEYGEN_MESSAGE =
  'Split private payments\n\n' +
  'Sign to set up and access your private receiving keys. This signature never ' +
  'leaves your device and is used only to derive your stealth keys.\n\n' +
  'Version: 1'

export interface StealthKeys {
  spendingPublicKey:  `0x${string}`
  spendingPrivateKey: `0x${string}`
  viewingPublicKey:   `0x${string}`
  viewingPrivateKey:  `0x${string}`
}

export interface StealthPayment {
  stealthAddress:     `0x${string}`
  ephemeralPublicKey: `0x${string}`
  viewTag:            `0x${string}`
}

export interface ScannableAnnouncement {
  stealthAddress:  `0x${string}`
  ephemeralPubKey: `0x${string}`
  metadata:        `0x${string}`
}

/** Derive the four stealth keys from a keygen-message signature. Deterministic. */
export function deriveStealthKeys(signature: `0x${string}`): StealthKeys {
  return generateKeysFromSignature(signature) as StealthKeys
}

/** Derive the publishable stealth meta-address (st:...) from the signature. */
export function deriveMetaAddress(signature: `0x${string}`): `0x${string}` {
  return generateStealthMetaAddressFromSignature(signature) as `0x${string}`
}

/**
 * Payer side: compute a fresh one-time stealth address for a recipient's
 * published meta-address, plus the ephemeral pubkey and view tag to announce.
 */
export function generateStealthPayment(metaAddressURI: `0x${string}`): StealthPayment {
  // The SDK accepts both the raw 0x meta-address and the st:<chain>:<...> URI and
  // validates the pubkeys downstream; guard here for a clear early error.
  if (!metaAddressURI || (!metaAddressURI.startsWith('0x') && !metaAddressURI.startsWith('st:'))) {
    throw new Error('Invalid stealth meta-address')
  }
  const { stealthAddress, ephemeralPublicKey, viewTag } = generateStealthAddress({
    stealthMetaAddressURI: metaAddressURI,
    schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
  })
  return {
    stealthAddress:     stealthAddress as `0x${string}`,
    ephemeralPublicKey: ephemeralPublicKey as `0x${string}`,
    viewTag:            viewTag as `0x${string}`,
  }
}

/**
 * ERC-5564 announcement metadata. Byte 0 MUST be the view tag (the announcer and
 * scanners rely on this). For Phase 3 the metadata is exactly the view tag; a
 * future version can append an encrypted note after it.
 */
export function buildAnnouncementMetadata(viewTag: `0x${string}`): `0x${string}` {
  return viewTag
}

/** A random EIP-3009 authorization nonce (bytes32). */
export function generateAuthorizationNonce(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/**
 * Build the EIP-712 typed data the payer signs so the gateway can pull funds via
 * USDC's receiveWithAuthorization. `to` MUST be the gateway (only it can execute).
 */
export function buildReceiveAuthorizationTypedData(params: {
  from:        `0x${string}`
  gateway:     `0x${string}`
  value:       bigint
  validAfter:  bigint
  validBefore: bigint
  nonce:       `0x${string}`
}) {
  return {
    domain:      USDC_EIP712_DOMAIN,
    types:       RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization' as const,
    message: {
      from:        params.from,
      to:          params.gateway,
      value:       params.value,
      validAfter:  params.validAfter,
      validBefore: params.validBefore,
      nonce:       params.nonce,
    },
  }
}

/**
 * Recipient side: does this announcement belong to me? Applies the EIP-5564
 * view-tag fast reject first (inside the SDK) before the elliptic-curve check.
 * Runs entirely on the user's device with their own keys.
 */
export function announcementIsMine(
  announcement: ScannableAnnouncement,
  keys: Pick<StealthKeys, 'spendingPublicKey' | 'viewingPrivateKey'>,
): boolean {
  try {
    const viewTag = getViewTagFromMetadata(announcement.metadata)
    return checkStealthAddress({
      userStealthAddress: announcement.stealthAddress,
      ephemeralPublicKey: announcement.ephemeralPubKey,
      viewTag,
      schemeId:           VALID_SCHEME_ID.SCHEME_ID_1,
      spendingPublicKey:  keys.spendingPublicKey,
      viewingPrivateKey:  keys.viewingPrivateKey,
    })
  } catch {
    // A malformed announcement (bad metadata/pubkey) is simply not ours.
    return false
  }
}
