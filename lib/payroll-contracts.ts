import { isAddress, getAddress } from 'viem'

// ── SplitPayroll address ───────────────────────────────────────────────────────
// Sibling of lib/contracts.ts (which is on the no-touch list) so that file is
// never edited. erc20Abi / splitAbi are imported from there where needed —
// importing is fine, editing is not.

/**
 * Returns the deployed SplitPayroll contract address, checksummed.
 * Throws at call-time if not yet set (set NEXT_PUBLIC_SPLIT_PAYROLL_CONTRACT
 * after the Phase 1 SplitPayroll deploy).
 */
export function getSplitPayrollContract(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_SPLIT_PAYROLL_CONTRACT
  if (!raw) {
    throw new Error(
      'NEXT_PUBLIC_SPLIT_PAYROLL_CONTRACT is not set — deploy SplitPayroll first (Phase 1)',
    )
  }
  if (!isAddress(raw)) {
    throw new Error(
      `NEXT_PUBLIC_SPLIT_PAYROLL_CONTRACT "${raw}" is not a valid hex address`,
    )
  }
  return getAddress(raw)
}

// The on-chain Payee tuple, in struct field order. Mirrors SplitPayroll.Payee.
export interface PayrollPayeeArg {
  readonly dest:        `0x${string}`
  readonly amount:      bigint      // uint128, 6-decimal USDC
  readonly isSplitUser: boolean
  readonly memoHash:    `0x${string}` // bytes32
}

// Per-payee outcome codes emitted in PayrollPayment.
export const PAYROLL_OUTCOME = {
  SPLIT:    0,
  FALLBACK: 1,
  PLAIN:    2,
  PRIVATE:  3,
} as const

// ── SplitPayrollV2 (adds a private-payment mode) ──────────────────────────────

/**
 * Returns the deployed SplitPayrollV2 address, checksummed. Throws if not set.
 * The payroll run flow uses V2 (a superset of V1) so a roster can mix normal and
 * private payees in one transaction.
 */
export function getSplitPayrollV2Contract(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_SPLIT_PAYROLL_V2
  if (!raw) throw new Error('NEXT_PUBLIC_SPLIT_PAYROLL_V2 is not set — deploy SplitPayrollV2 (Phase 4)')
  if (!isAddress(raw)) throw new Error(`NEXT_PUBLIC_SPLIT_PAYROLL_V2 "${raw}" is not a valid hex address`)
  return getAddress(raw)
}

// Payee.mode for SplitPayrollV2.runPayroll.
export const PAYROLL_MODE = {
  SPLIT:   0, // route through the payee's buckets (depositFor + fallback)
  PLAIN:   1, // direct transfer
  PRIVATE: 2, // transfer to a one-time stealth address + ERC-5564 announce
} as const

// The on-chain V2 Payee tuple, in struct field order.
export interface PayrollPayeeV2Arg {
  readonly dest:            `0x${string}`
  readonly amount:          bigint
  readonly mode:            number        // PAYROLL_MODE
  readonly memoHash:        `0x${string}`
  readonly ephemeralPubKey: `0x${string}` // private mode only, else '0x'
  readonly metadata:        `0x${string}` // private mode only, else '0x'
}

// SplitPayrollV2 ABI — shape verified against contracts/out/SplitPayrollV2.sol.
export const splitPayrollV2Abi = [
  {
    "type": "function",
    "name": "runPayroll",
    "inputs": [
      {
        "name": "payees", "type": "tuple[]", "internalType": "struct SplitPayrollV2.Payee[]",
        "components": [
          { "name": "dest", "type": "address", "internalType": "address" },
          { "name": "amount", "type": "uint128", "internalType": "uint128" },
          { "name": "mode", "type": "uint8", "internalType": "uint8" },
          { "name": "memoHash", "type": "bytes32", "internalType": "bytes32" },
          { "name": "ephemeralPubKey", "type": "bytes", "internalType": "bytes" },
          { "name": "metadata", "type": "bytes", "internalType": "bytes" }
        ]
      },
      { "name": "runId", "type": "uint256", "internalType": "uint256" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event", "name": "PayrollRun",
    "inputs": [
      { "name": "employer", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "runId", "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "total", "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "payeeCount", "type": "uint256", "indexed": false, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  {
    "type": "event", "name": "PayrollPayment",
    "inputs": [
      { "name": "employer", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "payee", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "amount", "type": "uint128", "indexed": false, "internalType": "uint128" },
      { "name": "outcome", "type": "uint8", "indexed": false, "internalType": "uint8" },
      { "name": "memoHash", "type": "bytes32", "indexed": false, "internalType": "bytes32" }
    ],
    "anonymous": false
  },
  { "type": "error", "name": "EmptyRun", "inputs": [] },
  { "type": "error", "name": "TooManyPayees", "inputs": [] },
  { "type": "error", "name": "ZeroAmount", "inputs": [] },
  { "type": "error", "name": "ZeroDestination", "inputs": [] },
  { "type": "error", "name": "BadMode", "inputs": [] }
] as const

// ── SplitPayroll ABI — copied verbatim from
//    contracts/out/SplitPayroll.sol/SplitPayroll.json after `forge build`.
//    NEVER hand-write or modify this array (same rule as lib/contracts.ts).

export const splitPayrollAbi = [
  {
    "type": "constructor",
    "inputs": [
      { "name": "usdc", "type": "address", "internalType": "address" },
      { "name": "split_", "type": "address", "internalType": "address" }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "MAX_PAYEES",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256", "internalType": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SPLIT",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address", "internalType": "contract ISplit" }],
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
    "name": "runPayroll",
    "inputs": [
      {
        "name": "payees",
        "type": "tuple[]",
        "internalType": "struct SplitPayroll.Payee[]",
        "components": [
          { "name": "dest", "type": "address", "internalType": "address" },
          { "name": "amount", "type": "uint128", "internalType": "uint128" },
          { "name": "isSplitUser", "type": "bool", "internalType": "bool" },
          { "name": "memoHash", "type": "bytes32", "internalType": "bytes32" }
        ]
      },
      { "name": "runId", "type": "uint256", "internalType": "uint256" }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "PayrollPayment",
    "inputs": [
      { "name": "employer", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "payee", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "amount", "type": "uint128", "indexed": false, "internalType": "uint128" },
      { "name": "outcome", "type": "uint8", "indexed": false, "internalType": "uint8" },
      { "name": "memoHash", "type": "bytes32", "indexed": false, "internalType": "bytes32" }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PayrollRun",
    "inputs": [
      { "name": "employer", "type": "address", "indexed": true, "internalType": "address" },
      { "name": "runId", "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "total", "type": "uint256", "indexed": false, "internalType": "uint256" },
      { "name": "payeeCount", "type": "uint256", "indexed": false, "internalType": "uint256" }
    ],
    "anonymous": false
  },
  { "type": "error", "name": "EmptyRun", "inputs": [] },
  { "type": "error", "name": "ReentrancyGuardReentrantCall", "inputs": [] },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [{ "name": "token", "type": "address", "internalType": "address" }]
  },
  { "type": "error", "name": "TooManyPayees", "inputs": [] },
  { "type": "error", "name": "ZeroAmount", "inputs": [] },
  { "type": "error", "name": "ZeroDestination", "inputs": [] }
] as const
