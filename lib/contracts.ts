import { isAddress, getAddress } from 'viem'

// ── Shared bucket type ────────────────────────────────────────────────────────
// Mirrors the on-chain Bucket struct. getBuckets returns active buckets only
// (deleted buckets are removed via swap-and-pop, never marked inactive).

export interface SplitBucket {
  readonly id:          bigint
  readonly name:        string
  readonly bps:         number          // uint16, 0–10 000
  readonly destination: `0x${string}`  // ZERO_ADDRESS means "hold in contract"
  readonly balance:     bigint          // uint128, 6-decimal USDC
  readonly active:      boolean
}

// address(0) sentinel — destination === ZERO_ADDRESS means a hold bucket
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// ── Addresses ─────────────────────────────────────────────────────────────────

// USDC ERC-20 on Arc Testnet — 6 decimals (not 18)
export const USDC = '0x3600000000000000000000000000000000000000' as const

/**
 * Returns the deployed Split contract address, checksummed.
 * Throws at call-time if not yet set (Phases 0–1 builds work without it).
 * Set NEXT_PUBLIC_SPLIT_CONTRACT after Phase 2 deploy.
 */
export function getSplitContract(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_SPLIT_CONTRACT
  if (!raw) {
    throw new Error(
      'NEXT_PUBLIC_SPLIT_CONTRACT is not set — deploy the contract first (Phase 2)',
    )
  }
  if (!isAddress(raw)) {
    throw new Error(
      `NEXT_PUBLIC_SPLIT_CONTRACT "${raw}" is not a valid hex address`,
    )
  }
  return getAddress(raw)
}

// ── ERC-20 ABI (approve / balanceOf / allowance) ──────────────────────────────

export const erc20Abi = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ── Split ABI — copied verbatim from out/Split.sol/Split.json after forge build ─
// NEVER hand-write or modify this array.
// Deployed: 0x071c2E7B525Db9850C9500326CF5D0a415fe6501 (Arc Testnet, chain 5042002)

export const splitAbi = [
  {
    "type": "constructor",
    "inputs": [
      { "name": "_usdc", "type": "address", "internalType": "address" },
      { "name": "_scheduler", "type": "address", "internalType": "address" }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "BPS_TOTAL",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_BUCKETS",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MIN_INTERVAL",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint64", "internalType": "uint64" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "USDC",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "contract IERC20" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "addBucket",
    "inputs": [
      { "name": "name", "type": "string", "internalType": "string" },
      { "name": "bps", "type": "uint16", "internalType": "uint16" },
      { "name": "destination", "type": "address", "internalType": "address" }
    ],
    "outputs": [{ "name": "id", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "cancelScheduledSend",
    "inputs": [{ "name": "bucketId", "type": "uint256", "internalType": "uint256" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deleteBucket",
    "inputs": [{ "name": "bucketId", "type": "uint256", "internalType": "uint256" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deposit",
    "inputs": [{ "name": "amount", "type": "uint128", "internalType": "uint128" }],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "depositFor",
    "inputs": [
      { "name": "recipient", "type": "address", "internalType": "address" },
      { "name": "amount", "type": "uint128", "internalType": "uint128" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "executeScheduledSend",
    "inputs": [
      { "name": "user", "type": "address", "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "internalType": "uint256" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getBuckets",
    "inputs": [{ "name": "user", "type": "address", "internalType": "address" }],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct Split.Bucket[]",
        "components": [
          { "name": "id", "type": "uint256", "internalType": "uint256" },
          { "name": "name", "type": "string", "internalType": "string" },
          { "name": "bps", "type": "uint16", "internalType": "uint16" },
          { "name": "destination", "type": "address", "internalType": "address" },
          { "name": "balance", "type": "uint128", "internalType": "uint128" },
          { "name": "active", "type": "bool", "internalType": "bool" }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getScheduledSend",
    "inputs": [
      { "name": "user", "type": "address", "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "internalType": "uint256" }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct Split.ScheduledSend",
        "components": [
          { "name": "amount", "type": "uint128", "internalType": "uint128" },
          { "name": "interval", "type": "uint64", "internalType": "uint64" },
          { "name": "nextSendAt", "type": "uint64", "internalType": "uint64" },
          { "name": "destination", "type": "address", "internalType": "address" },
          { "name": "active", "type": "bool", "internalType": "bool" }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "scheduler",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "address" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setScheduledSend",
    "inputs": [
      { "name": "bucketId", "type": "uint256", "internalType": "uint256" },
      { "name": "amount", "type": "uint128", "internalType": "uint128" },
      { "name": "interval", "type": "uint64", "internalType": "uint64" },
      { "name": "destination", "type": "address", "internalType": "address" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "totalBPS",
    "inputs": [{ "name": "user", "type": "address", "internalType": "address" }],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "updateBucket",
    "inputs": [
      { "name": "bucketId", "type": "uint256", "internalType": "uint256" },
      { "name": "name", "type": "string", "internalType": "string" },
      { "name": "newBps", "type": "uint16", "internalType": "uint16" },
      { "name": "destination", "type": "address", "internalType": "address" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      { "name": "bucketId", "type": "uint256", "internalType": "uint256" },
      { "name": "amount", "type": "uint128", "internalType": "uint128" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "withdrawTo",
    "inputs": [
      { "name": "bucketId", "type": "uint256", "internalType": "uint256" },
      { "name": "amount", "type": "uint128", "internalType": "uint128" },
      { "name": "to", "type": "address", "internalType": "address" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "BucketAdded",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "name", "type": "string", "indexed": false, "internalType": "string" },
      { "name": "bps", "type": "uint16", "indexed": false, "internalType": "uint16" },
      { "name": "destination", "type": "address", "indexed": false, "internalType": "address" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BucketDeleted",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": false, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BucketSplit",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "share", "type": "uint128", "indexed": false, "internalType": "uint128" },
      { "name": "destination", "type": "address", "indexed": false, "internalType": "address" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "BucketUpdated",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "name", "type": "string", "indexed": false, "internalType": "string" },
      { "name": "bps", "type": "uint16", "indexed": false, "internalType": "uint16" },
      { "name": "destination", "type": "address", "indexed": false, "internalType": "address" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Deposited",
    "inputs": [
      { "name": "recipient", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "sender", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "amount", "type": "uint128", "indexed": false, "internalType": "uint128" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ScheduledSendCancelled",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": true, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ScheduledSendExecuted",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "amount", "type": "uint128", "indexed": false, "internalType": "uint128" },
      { "name": "destination", "type": "address", "indexed": false, "internalType": "address" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ScheduledSendSet",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": true, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdrawn",
    "inputs": [
      { "name": "user", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "bucketId", "type": "uint256", "indexed": true, "internalType": "uint256" },
      { "name": "amount", "type": "uint128", "indexed": false, "internalType": "uint128" },
      { "name": "to", "type": "address", "indexed": false, "internalType": "address" }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BucketNotFound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DestinationRequired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExceedsBPS",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientBalance",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidAmount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidBPSTotal",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidInterval",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoBuckets",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotScheduler",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [{ "name": "token", "type": "address", "internalType": "address" }]
  },
  {
    "type": "error",
    "name": "TooEarly",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyBuckets",
    "inputs": []
  }
] as const

// ── Memo Contract ─────────────────────────────────────────────────────────────
// Arc protocol-level memo contract — wraps any call, preserves msg.sender,
// and emits a structured Memo event. Approve always targets SPLIT_CONTRACT.

export const MEMO_CONTRACT = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505' as const

export const memoAbi = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target',   type: 'address' },
      { name: 'data',     type: 'bytes'   },
      { name: 'memoId',   type: 'bytes32' },
      { name: 'memoData', type: 'bytes'   },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'BeforeMemo',
    anonymous: false,
    inputs: [
      { name: 'memoIndex', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Memo',
    anonymous: false,
    inputs: [
      { name: 'sender',       type: 'address', indexed: true  },
      { name: 'target',       type: 'address', indexed: true  },
      { name: 'callDataHash', type: 'bytes32', indexed: false },
      { name: 'memoId',       type: 'bytes32', indexed: true  },
      { name: 'memo',         type: 'bytes',   indexed: false },
      { name: 'memoIndex',    type: 'uint256', indexed: false },
    ],
  },
] as const
