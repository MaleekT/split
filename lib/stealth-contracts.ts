import { isAddress, getAddress } from 'viem'
import { USDC } from './contracts'
import { arcTestnet } from './chain'

// ── Addresses (set after DeployStealth runs; see Phase 3 manual deploy step) ──

function addressFromEnv(value: string | undefined, name: string): `0x${string}` {
  if (!value) throw new Error(`${name} is not set — deploy the stealth contracts first (Phase 3)`)
  if (!isAddress(value)) throw new Error(`${name} "${value}" is not a valid hex address`)
  return getAddress(value)
}

export function getAnnouncerContract(): `0x${string}` {
  return addressFromEnv(process.env.NEXT_PUBLIC_STEALTH_ANNOUNCER, 'NEXT_PUBLIC_STEALTH_ANNOUNCER')
}
export function getRegistryContract(): `0x${string}` {
  return addressFromEnv(process.env.NEXT_PUBLIC_STEALTH_REGISTRY, 'NEXT_PUBLIC_STEALTH_REGISTRY')
}
export function getStealthGatewayContract(): `0x${string}` {
  return addressFromEnv(process.env.NEXT_PUBLIC_STEALTH_GATEWAY, 'NEXT_PUBLIC_STEALTH_GATEWAY')
}

// ERC-5564 scheme id for secp256k1 stealth addresses.
export const STEALTH_SCHEME_ID = 1n

// An ERC-5564 scheme-1 meta-address is exactly two 33-byte compressed secp256k1
// public keys (spending + viewing) = 66 bytes = 132 hex chars. Validated on both
// the write path (registration) and the read path (pay pages) from this single
// definition: this value feeds stealth-address derivation, so a malformed one
// would route funds to an address the recipient cannot spend from.
export const META_ADDRESS_RE = /^0x[0-9a-fA-F]{132}$/

/**
 * Canonical message the account owner signs to register their meta-address
 * off-chain. Isomorphic so client and server build it identically; the server
 * verifies the signature recovers to `address`.
 */
export function buildStealthRegisterMessage(address: string, metaAddress: string): string {
  return [
    'Split: register private-payment keys',
    `Meta: ${metaAddress}`,
    `For: ${address.toLowerCase()}`,
  ].join('\n')
}

// ── USDC EIP-712 domain for ReceiveWithAuthorization ──────────────────────────
// Verified against the live on-chain DOMAIN_SEPARATOR: name "USDC", version "2",
// chainId 5042002, verifyingContract 0x3600...0000. A mismatch would make the
// gateway's receiveWithAuthorization pull revert, so this is pinned deliberately.
export const USDC_EIP712_DOMAIN = {
  name:              'USDC',
  version:           '2',
  chainId:           arcTestnet.id,
  verifyingContract: USDC,
} as const

// EIP-3009 ReceiveWithAuthorization typed-data types (for viem signTypedData).
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
} as const

// ── ABIs — copied verbatim from contracts/out/*.json after `forge build`.
//    NEVER hand-edit (same rule as lib/contracts.ts). ─────────────────────────

export const stealthGatewayAbi = [
  {
    "type": "function",
    "name": "payStealth",
    "inputs": [
      {
        "name": "auth", "type": "tuple", "internalType": "struct StealthPayGateway.Authorization",
        "components": [
          { "name": "from", "type": "address", "internalType": "address" },
          { "name": "value", "type": "uint256", "internalType": "uint256" },
          { "name": "validAfter", "type": "uint256", "internalType": "uint256" },
          { "name": "validBefore", "type": "uint256", "internalType": "uint256" },
          { "name": "nonce", "type": "bytes32", "internalType": "bytes32" },
          { "name": "v", "type": "uint8", "internalType": "uint8" },
          { "name": "r", "type": "bytes32", "internalType": "bytes32" },
          { "name": "s", "type": "bytes32", "internalType": "bytes32" }
        ]
      },
      {
        "name": "ann", "type": "tuple", "internalType": "struct StealthPayGateway.StealthAnnouncement",
        "components": [
          { "name": "stealthAddress", "type": "address", "internalType": "address" },
          { "name": "ephemeralPubKey", "type": "bytes", "internalType": "bytes" },
          { "name": "metadata", "type": "bytes", "internalType": "bytes" }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  { "type": "error", "name": "ZeroStealthAddress", "inputs": [] },
  { "type": "error", "name": "ZeroValue", "inputs": [] }
] as const

export const announcerAbi = [
  {
    "type": "function",
    "name": "announce",
    "inputs": [
      { "name": "schemeId", "type": "uint256", "internalType": "uint256" },
      { "name": "stealthAddress", "type": "address", "internalType": "address" },
      { "name": "ephemeralPubKey", "type": "bytes", "internalType": "bytes" },
      { "name": "metadata", "type": "bytes", "internalType": "bytes" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Announcement",
    "inputs": [
      { "name": "schemeId", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "stealthAddress", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "caller", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "ephemeralPubKey", "type": "bytes", "indexed": false, "internalType": "bytes" },
      { "name": "metadata", "type": "bytes", "indexed": false, "internalType": "bytes" }
    ],
    "anonymous": false
  }
] as const

export const registryAbi = [
  {
    "type": "function",
    "name": "registerKeys",
    "inputs": [
      { "name": "schemeId", "type": "uint256", "internalType": "uint256" },
      { "name": "stealthMetaAddress", "type": "bytes", "internalType": "bytes" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "stealthMetaAddressOf",
    "inputs": [
      { "name": "registrant", "type": "address", "internalType": "address" },
      { "name": "schemeId", "type": "uint256", "internalType": "uint256" }
    ],
    "outputs": [{ "name": "", "type": "bytes", "internalType": "bytes" }],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "StealthMetaAddressSet",
    "inputs": [
      { "name": "registrant", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "schemeId", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "stealthMetaAddress", "type": "bytes", "indexed": false, "internalType": "bytes" }
    ],
    "anonymous": false
  }
] as const
