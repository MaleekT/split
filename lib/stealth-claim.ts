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
import { USDC, erc20Abi, getSplitContract, splitAbi } from './contracts'
import { computeClaimPlan, claimTransferCount, type ClaimBucket } from './claim-math'

// erc20Abi in lib/contracts.ts (no-touch) has approve/balanceOf/allowance but not
// transfer, which Private Claim needs; define it locally.
const erc20TransferAbi = [{
  name: 'transfer', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const

const NATIVE_PER_USDC       = 10n ** 12n // 18-dec native per 6-dec USDC unit
const GAS_MARGIN            = 2n         // 100% safety on estimated gas
const FALLBACK_DEPOSIT_GAS  = 450_000n   // depositFor with up to 10 buckets
const FALLBACK_TRANSFER_GAS = 90_000n    // one USDC facade transfer

export interface QuickClaimResult { approveTx: `0x${string}`; claimTx: `0x${string}`; amountRaw: bigint }
export interface PrivateClaimResult { transfers: `0x${string}`[]; amountRaw: bigint }

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

async function gasPriceWei(): Promise<bigint> {
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
 * from the stealth address straight to each auto-send bucket destination, with
 * hold-bucket shares going to the main address. Never touches the Split contract,
 * so no single event links the stealth address to the account (only statistical
 * timing/amount correlation remains, surfaced in the UI). Hold shares to the
 * main address are a deliberate partial link, per the design.
 */
export async function privateClaim(params: {
  stealthPrivateKey: `0x${string}`
  mainAddress:       `0x${string}`
  buckets:           readonly ClaimBucket[]
}): Promise<PrivateClaimResult> {
  const wallet  = walletFor(params.stealthPrivateKey)
  const stealth = wallet.account!.address
  const price   = await gasPriceWei()

  const balanceWei = await publicClient.getBalance({ address: stealth })

  // Reserve gas for the worst-case transfer count (every active auto-send bucket
  // plus one main-address transfer), then size the claim to the remainder.
  const activeAutoSends = params.buckets.filter(
    (b) => b.active && b.destination !== '0x0000000000000000000000000000000000000000',
  ).length
  const maxTransfers = BigInt(activeAutoSends + 1)
  const reserve = reserveWei(maxTransfers * FALLBACK_TRANSFER_GAS, price)
  if (balanceWei <= reserve) throw new Error('Balance too low to cover claim gas')

  const amountRaw = (balanceWei - reserve) / NATIVE_PER_USDC
  if (amountRaw === 0n) throw new Error('Nothing left to claim after gas')

  const plan = computeClaimPlan(params.buckets, amountRaw)
  if (claimTransferCount(plan) === 0) throw new Error('No buckets to distribute to')

  // Send each transfer sequentially. On a mid-sequence failure the already-sent
  // transfers stand and the remainder stays at the stealth address (re-scannable
  // and re-claimable), so no funds are ever stranded.
  const transfers: `0x${string}`[] = []
  const sends = [
    ...plan.autoSends.map((t) => ({ to: t.destination, amount: t.amount })),
    ...(plan.toMainAddress > 0n ? [{ to: params.mainAddress, amount: plan.toMainAddress }] : []),
  ]
  for (const s of sends) {
    const tx = await wallet.writeContract({
      address: USDC, abi: erc20TransferAbi, functionName: 'transfer', args: [s.to, s.amount],
      chain: arcTestnet, account: wallet.account!,
    })
    await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })
    transfers.push(tx)
  }

  return { transfers, amountRaw }
}
