'use client'

import { useCallback, useState } from 'react'
import { useAccount, useSignTypedData } from 'wagmi'
import { createWalletClient, http, isAddress, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from '@/lib/chain'
import { publicClient } from '@/lib/arc'
import { USDC } from '@/lib/contracts'
import {
  bucketWalletTypedData,
  deriveBucketWalletKey,
  deriveBucketWalletAddress,
  recoverBucketWalletIndices,
  DEFAULT_SCAN_BOUND,
  MAX_DERIVATION_INDEX,
} from '@/lib/bucket-wallet'
import { gasPriceWei, sendableBalanceRaw, erc20TransferAbi, waitForReceipt } from '@/lib/stealth-claim'

// Generated wallet-buckets: buckets whose destination is an address Split derives
// from the user's signature, so it can spend from them without a wallet popup.
//
// In-memory only, like the Vault: the signature and derived keys never leave the
// device and never reach a server. A page refresh clears them and the user
// re-signs, which is what makes these recoverable on any device.
const walletCache = new Map<string, `0x${string}`>()  // main address -> signature

// Bounded so a pathological run of index conflicts cannot spin forever. Each
// attempt is one HTTP round trip, and conflicts only happen when two tabs create
// buckets at the same instant, so this is far more headroom than real use needs.
const MAX_RESERVE_ATTEMPTS = 25

export interface GeneratedBucketWallet {
  bucketId:        number
  derivationIndex: number
  walletAddress:   `0x${string}`
}

export interface AllocatedWallet {
  derivationIndex: number
  walletAddress:   `0x${string}`
}

export function useBucketWallets() {
  const { address }              = useAccount()
  const { signTypedDataAsync }   = useSignTypedData()
  const [busy, setBusy]          = useState(false)

  /**
   * Derive (and cache) the signature these wallets come from. Signs twice and
   * compares: a wallet whose signatures are not deterministic would derive
   * different keys later and strand every generated bucket permanently, so this
   * must fail loudly before any funds can be routed to one.
   */
  const unlock = useCallback(async (): Promise<`0x${string}`> => {
    if (!address) throw new Error('Connect your wallet first')
    const cached = walletCache.get(address)
    if (cached) return cached

    const typedData = bucketWalletTypedData(arcTestnet.id)
    const sigA = await signTypedDataAsync(typedData) as `0x${string}`
    const sigB = await signTypedDataAsync(typedData) as `0x${string}`
    if (sigA !== sigB) {
      throw new Error(
        'Your wallet produced different signatures for the same request, so generated bucket wallets could not be recovered later. They are not supported for this wallet.',
      )
    }
    walletCache.set(address, sigA)
    return sigA
  }, [address, signTypedDataAsync])

  const isUnlocked = useCallback((): boolean => !!address && walletCache.has(address), [address])

  /**
   * Pick the next free derivation index and reserve it.
   *
   * Allocation is chain-authoritative: an index is only free if its derived
   * address is not already a destination on one of this user's buckets. The
   * server reservation is the atomic race guard on top of that - if another tab
   * claims the same index first, the insert loses on the unique constraint and we
   * move to the next one.
   */
  const allocateAndReserve = useCallback(async (
    existingDestinations: readonly `0x${string}`[],
  ): Promise<AllocatedWallet> => {
    if (!address) throw new Error('Connect your wallet first')
    const signature = await unlock()

    const used = new Set(existingDestinations.map((d) => d.toLowerCase()))

    // Seed from indices the server already holds, so the common case reserves on
    // the first try instead of colliding its way up from zero.
    let taken = new Set<number>()
    try {
      const r = await fetch(`/api/bucket-wallets/reserve?address=${encodeURIComponent(address)}`)
      if (r.ok) {
        const body = await r.json() as { data?: { takenIndices?: number[] } }
        taken = new Set(body.data?.takenIndices ?? [])
      }
    } catch {
      // Non-critical: without the hint we just collide and retry, which is correct
      // anyway. The unique constraint remains the real guarantee.
    }

    let index = 0
    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
      while (
        index <= MAX_DERIVATION_INDEX &&
        (taken.has(index) || used.has(deriveBucketWalletAddress(signature, index).toLowerCase()))
      ) {
        index++
      }
      if (index > MAX_DERIVATION_INDEX) {
        throw new Error('No derivation index is available for a new generated wallet.')
      }

      const walletAddress = deriveBucketWalletAddress(signature, index)
      const res = await fetch('/api/bucket-wallets/reserve', {
        method:  'POST',
        // X-Requested-With is REQUIRED: both write routes reject without it, the
        // same CSRF guard /api/bucket-icons and /api/goals use. Omitting it makes
        // every reserve return 400, which surfaces as a generic failure.
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body:    JSON.stringify({ address, walletAddress, derivationIndex: index }),
      })

      if (res.ok) return { derivationIndex: index, walletAddress }

      const body = await res.json().catch(() => ({})) as { error?: string; message?: string; takenIndices?: number[] }
      if (res.status === 409 && body.error === 'index_taken') {
        // Another tab won this index. Refresh the taken set and try the next.
        for (const i of body.takenIndices ?? []) taken.add(i)
        taken.add(index)
        index++
        continue
      }
      throw new Error(body.message || 'Could not reserve a wallet index')
    }
    throw new Error('Could not reserve a wallet index after repeated conflicts. Try again.')
  }, [address, unlock])

  /** Attach a reservation to the bucket id, once addBucket has confirmed. */
  const bind = useCallback(async (
    walletAddress: `0x${string}`,
    bucketId: number,
  ): Promise<void> => {
    if (!address) throw new Error('Connect your wallet first')
    const res = await fetch('/api/bucket-wallets/bind', {
      method:  'POST',
      // Same CSRF guard as reserve. Without it bind returns 400 and the bucket is
      // created but never labelled as generated.
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body:    JSON.stringify({ address, walletAddress, bucketId }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string }
      // Non-fatal by design: the bucket works regardless, because recovery can
      // resolve it from the chain. Surfaced so the caller can warn rather than
      // silently leave the badge missing.
      throw new Error(body.message || 'The bucket was created, but labelling it as generated failed.')
    }
  }, [address])

  /** Which of this user's buckets have a generated destination, per the server hint. */
  const listGenerated = useCallback(async (): Promise<GeneratedBucketWallet[]> => {
    if (!address) return []
    const res = await fetch(`/api/bucket-wallets/${encodeURIComponent(address)}`)
    if (!res.ok) return []
    const body = await res.json() as { data?: { wallets?: GeneratedBucketWallet[] } }
    return body.data?.wallets ?? []
  }, [address])

  /**
   * Resolve destinations to derivation indices without the database. Unmatched
   * destinations come back as `unresolved` - callers must render that state rather
   * than treating them as ordinary pasted addresses.
   */
  const recover = useCallback(async (
    destinations: readonly `0x${string}`[],
    maxIndex: number = DEFAULT_SCAN_BOUND,
  ) => {
    const signature = await unlock()
    return recoverBucketWalletIndices(signature, destinations, maxIndex)
  }, [unlock])

  /**
   * Send USDC from a generated bucket wallet. Signs locally, so no wallet popup.
   *
   * `expectedDestination` is the bucket's destination as read from the CHAIN. The
   * derived address must equal it or nothing is sent: the server hint that told us
   * which index to use is never trusted to move money.
   */
  const sendFrom = useCallback(async (params: {
    derivationIndex:     number
    expectedDestination: `0x${string}`
    to:                  `0x${string}`
    amountRaw:           bigint
  }): Promise<`0x${string}`> => {
    const { derivationIndex, expectedDestination, to, amountRaw } = params
    if (!isAddress(to)) throw new Error('Enter a valid destination address')
    if (amountRaw <= 0n) throw new Error('Enter an amount greater than zero')

    const signature = await unlock()
    const privateKey = deriveBucketWalletKey(signature, derivationIndex)
    const derived    = privateKeyToAccount(privateKey).address

    if (getAddress(derived) !== getAddress(expectedDestination)) {
      throw new Error(
        'The key derived from your wallet does not control this bucket\'s destination. Nothing was sent. Reconnect the wallet that created it.',
      )
    }

    // On Arc the wallet's USDC balance IS its gas, so a send must leave a reserve.
    const price   = await gasPriceWei()
    const sendable = await sendableBalanceRaw(derived, price)
    if (amountRaw > sendable) {
      throw new Error('That is more than this wallet can send once gas is covered.')
    }

    const wallet = createWalletClient({
      account:   privateKeyToAccount(privateKey),
      chain:     arcTestnet,
      transport: http(process.env.NEXT_PUBLIC_ARC_RPC),
    })
    const tx = await wallet.writeContract({
      address: USDC, abi: erc20TransferAbi, functionName: 'transfer', args: [to, amountRaw],
      chain: arcTestnet, account: wallet.account!, gas: 90_000n,
      maxFeePerGas: price, maxPriorityFeePerGas: 0n,
    })
    // Resilient wait: a throttled RPC must not make a landed transfer report itself
    // as failed, which is exactly the bug fixed in aa9f179 for claims.
    await waitForReceipt(tx)
    return tx
  }, [unlock])

  /** Spendable balance of a generated wallet, after reserving gas. */
  const spendableBalance = useCallback(async (walletAddress: `0x${string}`): Promise<bigint> => {
    return sendableBalanceRaw(walletAddress, await gasPriceWei())
  }, [])

  return {
    address, busy, setBusy,
    unlock, isUnlocked, allocateAndReserve, bind, listGenerated, recover,
    sendFrom, spendableBalance,
  }
}
