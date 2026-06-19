import { keccak256, toHex, hexToString, encodeFunctionData } from 'viem'
import { MEMO_CONTRACT, memoAbi, splitAbi, getSplitContract } from './contracts'

export function buildDepositForMemo(
  recipient: `0x${string}`,
  amount: bigint,
  note: string,
) {
  if (!note.trim()) return null
  const trimmed = note.trim()
  const innerData = encodeFunctionData({ abi: splitAbi, functionName: 'depositFor', args: [recipient, amount] })
  return {
    address:      MEMO_CONTRACT,
    abi:          memoAbi,
    functionName: 'memo' as const,
    args:         [getSplitContract(), innerData, keccak256(toHex(trimmed)), toHex(trimmed)] as const,
  }
}

export function buildDepositMemo(
  amount: bigint,
  note: string,
) {
  if (!note.trim()) return null
  const trimmed = note.trim()
  const innerData = encodeFunctionData({ abi: splitAbi, functionName: 'deposit', args: [amount] })
  return {
    address:      MEMO_CONTRACT,
    abi:          memoAbi,
    functionName: 'memo' as const,
    args:         [getSplitContract(), innerData, keccak256(toHex(trimmed)), toHex(trimmed)] as const,
  }
}

export function decodeMemoText(memoHex: `0x${string}`): string {
  try { return hexToString(memoHex) }
  catch { return '' }
}
