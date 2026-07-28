// Claim executors for stealth payments. CLIENT-ONLY (uses the SDK + a locally
// built wallet). The app computes the one-time stealth address's private key from
// the recipient's own keys and signs the claim transactions itself, so claiming
// is "zero wallet popups" (the connected wallet is only used earlier to derive
// the stealth keys). The stealth key exists in memory transiently and is never
// persisted or transmitted.
//
// Gas note (Arc): a stealth address's USDC balance IS its native gas balance,
// one pot, native being 18-decimal and the USDC facade 6-decimal (factor 1e12).
// So a claim can never move the full balance; it must leave a gas reserve. Both
// modes reserve gas from the received funds and claim the remainder.

import { createWalletClient, http, maxUint256, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { computeStealthKey, VALID_SCHEME_ID } from '@scopelift/stealth-address-sdk'
import { arcTestnet } from './chain'
import { publicClient } from './arc'
import { USDC, erc20Abi, getSplitContract, splitAbi, ZERO_ADDRESS } from './contracts'
import {
  computeClaimPlan, claimTransferCount,
  NATIVE_PER_USDC, GAS_MARGIN, DEPOSIT_GAS, TRANSFER_GAS,
  type ClaimBucket,
} from './claim-math'

// erc20Abi in lib/contracts.ts (no-touch) has approve/balanceOf/allowance but not
// transfer, which Private Claim needs; define it locally.
const erc20TransferAbi = [{
  name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const

// Gas constants live in claim-math so the UI's dust threshold is computed from
// the same numbers these executors reserve against; if they drifted, the UI would
// offer a Claim button for an amount the executor then refuses.
const FALLBACK_DEPOSIT_GAS  = DEPOSIT_GAS
const FALLBACK_TRANSFER_GAS = TRANSFER_GAS

export interface QuickClaimResult { approveTx: `0x${string}`; claimTx: `0x${string}`; amountRaw: bigint }
export interface PrivateClaimResult {
  transfers: `0x${string}`[]
  /** Amount actually moved by this claim (sum of the transfers sent). */
  amountRaw: bigint
  /**
   * Hold-bucket portion deliberately LEFT at the stealth address because no Vault
   * exists to receive it. Not lost: the next scan re-detects it and it becomes
   * claimable once a Vault is created. Surfaced so the UI can say so plainly
   * instead of implying the whole payment was distributed.
   */
  deferredRaw: bigint
}

/**
 * Derive the one-time stealth address's private key from the recipient's keys
 * and this payment's ephemeral public key. Delegated to the audited SDK.
 */
export function computeStealthPrivateKey(params: {
  ephemeralPublicKey: `0x${string}`
  spendingPrivateKey: `0x${string}`
  viewingPrivateKey:  `0x${string}`
}): `0x${string}` {
  return computeStealthKey({
    ephemeralPublicKey: params.ephemeralPublicKey,
    schemeId:           VALID_SCHEME_ID.SCHEME_ID_1,
    spendingPrivateKey: params.spendingPrivateKey,
    viewingPrivateKey:  params.viewingPrivateKey,
  }) as `0x${string}`
}

function walletFor(stealthPrivateKey: `0x${string}`): WalletClient {
  const rpc = process.env.NEXT_PUBLIC_ARC_RPC
  if (!rpc) throw new Error('NEXT_PUBLIC_ARC_RPC is not configured')
  return createWalletClient({
    account:   privateKeyToAccount(stealthPrivateKey),
    chain:     arcTestnet,
    transport: http(rpc),
  })
}

/** Current gas price, with a fallback so a flaky RPC cannot block a claim. */
export async function gasPriceWei(): Promise<bigint> {
  try { return await publicClient.getGasPrice() } catch { return 20_000_000_000n } // 20 gwei fallback
}

/** Native wei to reserve for `gasUnits` of work, with margin. */
function reserveWei(gasUnits: bigint, price: bigint): bigint {
  return gasUnits * price * GAS_MARGIN
}

/**
 * Quick Claim: the stealth address approves Split and calls
 * depositFor(mainAddress, amount), so the recipient's full bucket routing runs.
 * Two app-signed transactions, no wallet popups. Publicly links THIS stealth
 * address to the main account at claim time (the sender-to-recipient link stays
 * hidden). The claim amount is the balance minus a gas reserve.
 */
export async function quickClaim(params: {
  stealthPrivateKey: `0x${string}`
  mainAddress:       `0x${string}`
}): Promise<QuickClaimResult> {
  const wallet  = walletFor(params.stealthPrivateKey)
  const stealth = wallet.account!.address
  const split   = getSplitContract()
  const price   = await gasPriceWei()

  // 1. Approve Split (max; the stealth address is single-use, so a lingering
  //    allowance is harmless and it will hold nothing after the claim).
  const approveTx = await wallet.writeContract({
    address: USDC, abi: erc20Abi, functionName: 'approve', args: [split, maxUint256],
    chain: arcTestnet, account: wallet.account!,
  })
  await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 60_000 })

  // 2. Fresh balance after the approve gas, then size the claim against a real
  //    depositFor estimate.
  const balanceWei = await publicClient.getBalance({ address: stealth })
  const roughReserve = reserveWei(FALLBACK_DEPOSIT_GAS, price)
  if (balanceWei <= roughReserve) throw new Error('Balance too low to cover claim gas')
  const provisionalAmount = (balanceWei - roughReserve) / NATIVE_PER_USDC

  let estGas = FALLBACK_DEPOSIT_GAS
  try {
    estGas = await publicClient.estimateContractGas({
      address: split, abi: splitAbi, functionName: 'depositFor',
      args: [params.mainAddress, provisionalAmount], account: stealth,
    })
  } catch { /* keep fallback estimate */ }

  const reserve = reserveWei(estGas, price)
  if (balanceWei <= reserve) throw new Error('Balance too low to cover claim gas')
  const amountRaw = (balanceWei - reserve) / NATIVE_PER_USDC
  if (amountRaw === 0n) throw new Error('Nothing left to claim after gas')

  // 3. depositFor routes it through the recipient's buckets.
  const claimTx = await wallet.writeContract({
    address: split, abi: splitAbi, functionName: 'depositFor',
    args: [params.mainAddress, amountRaw], chain: arcTestnet, account: wallet.account!,
  })
  await publicClient.waitForTransactionReceipt({ hash: claimTx, timeout: 60_000 })

  return { approveTx, claimTx, amountRaw }
}

/**
 * Private Claim: compute each bucket's share locally and send plain transfers
 * from the stealth address straight to each auto-send bucket destination. Never
 * touches the Split contract, so no single event links the stealth address to the
 * account (only statistical timing/amount correlation remains, surfaced in the UI).
 *
 * Hold-bucket shares go to the user's Private Vault. Where no Vault exists they
 * are DEFERRED - left untouched at the stealth address for a later claim - and are
 * never sent to the main address. That old fallback published the payment to the
 * user's public identity, defeating the private path it was part of.
 *
 * Partial by design: the auto-send portions complete even when the hold portion
 * cannot, so a missing Vault never blocks the rest of a payment.
 */
export async function privateClaim(params: {
  stealthPrivateKey: `0x${string}`
  buckets:           readonly ClaimBucket[]
  /** Destination for the hold-bucket portion. Null = defer it, never send it. */
  vaultAddress:      `0x${string}` | null
}): Promise<PrivateClaimResult> {
  const wallet  = walletFor(params.stealthPrivateKey)
  const stealth = wallet.account!.address
  const price   = await gasPriceWei()

  const balanceWei = await publicClient.getBalance({ address: stealth })

  // Size the gas reserve to the transfers this claim will ACTUALLY make: one per
  // active auto-send bucket, plus one to the Vault when there is one. Without a
  // Vault the hold portion moves nothing, so it costs no gas - which is what makes
  // a partial claim cheaper than the old all-or-nothing one.
  const activeAutoSends = params.buckets.filter(
    (b) => b.active && b.destination !== ZERO_ADDRESS,
  ).length
  const transferCount = activeAutoSends + (params.vaultAddress !== null ? 1 : 0)
  if (transferCount === 0) {
    throw new Error(
      'Nothing here can be claimed yet: every active bucket holds in the contract and you have no Private Vault. Create a Vault, then claim.',
    )
  }

  const reserve = reserveWei(BigInt(transferCount) * FALLBACK_TRANSFER_GAS, price)
  if (balanceWei <= reserve) throw new Error('Balance too low to cover claim gas')

  const claimable = (balanceWei - reserve) / NATIVE_PER_USDC
  if (claimable === 0n) throw new Error('Nothing left to claim after gas')

  const plan = computeClaimPlan(params.buckets, claimable, params.vaultAddress)
  if (claimTransferCount(plan) === 0) {
    // Every share landed in the deferred bucket, so there is genuinely nothing to
    // send. Report it as deferred rather than failing: no funds are at risk.
    return { transfers: [], amountRaw: 0n, deferredRaw: plan.deferredRaw }
  }

  // Send each transfer sequentially. On a mid-sequence failure the already-sent
  // transfers stand and the remainder stays at the stealth address (re-scannable
  // and re-claimable), so no funds are ever stranded.
  const transfers: `0x${string}`[] = []
  let movedRaw = 0n
  for (const t of plan.autoSends) {
    const tx = await wallet.writeContract({
      address: USDC, abi: erc20TransferAbi, functionName: 'transfer', args: [t.destination, t.amount],
      chain: arcTestnet, account: wallet.account!,
    })
    await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })
    transfers.push(tx)
    // Counted only after the receipt confirms, so a mid-sequence failure reports
    // what actually moved rather than what was planned.
    movedRaw += t.amount
  }

  return { transfers, amountRaw: movedRaw, deferredRaw: plan.deferredRaw }
}

/**
 * Step 7: sweep the Private Vault to the user's main wallet.
 *
 * Deliberate consolidation, never automatic. This is the single action that
 * publicly links the Vault to the main address on-chain, and because the Vault is
 * a reused address, doing so can retroactively expose everything it ever received.
 * The caller is responsible for confirming that with the user first.
 *
 * Same Arc gas economics as a claim: the Vault's USDC balance IS its gas balance,
 * so it can never move its full balance and must leave a reserve.
 */
export async function sweepVaultToMain(params: {
  vaultPrivateKey: `0x${string}`
  mainAddress:     `0x${string}`
}): Promise<{ txHash: `0x${string}`; amountRaw: bigint }> {
  const wallet = walletFor(params.vaultPrivateKey)
  const vault  = wallet.account!.address
  const price  = await gasPriceWei()

  const balanceWei = await publicClient.getBalance({ address: vault })
  const reserve    = reserveWei(FALLBACK_TRANSFER_GAS, price)
  if (balanceWei <= reserve) throw new Error('Vault balance is too low to cover the transfer gas')

  // Floor division is required, not incidental: native is 18-decimal and the USDC
  // facade 6-decimal, so this is the 1e12 conversion. Truncating DOWN is the safe
  // direction - rounding up would try to move more than the balance covers and
  // revert. The sub-0.000001 USDC remainder stays in the Vault as dust.
  const amountRaw = (balanceWei - reserve) / NATIVE_PER_USDC
  if (amountRaw === 0n) throw new Error('Nothing left to move after gas')

  const txHash = await wallet.writeContract({
    address: USDC, abi: erc20TransferAbi, functionName: 'transfer',
    args: [params.mainAddress, amountRaw],
    chain: arcTestnet, account: wallet.account!,
  })
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 })

  return { txHash, amountRaw }
}
