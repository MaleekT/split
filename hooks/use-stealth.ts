'use client'

import { useCallback, useState } from 'react'
import { useAccount, useSignMessage, useWriteContract } from 'wagmi'
import { publicClient } from '@/lib/arc'
import { USDC, erc20Abi, getSplitContract, splitAbi } from '@/lib/contracts'
import {
  computeStealthPrivateKey,
  quickClaim,
  privateClaim,
  gasPriceWei,
  type QuickClaimResult,
  type PrivateClaimResult,
} from '@/lib/stealth-claim'
import { claimReserveRaw, isDustAmount, type ClaimBucket } from '@/lib/claim-math'
import {
  getRegistryContract,
  registryAbi,
  buildStealthRegisterMessage,
  STEALTH_SCHEME_ID,
} from '@/lib/stealth-contracts'
import {
  STEALTH_KEYGEN_MESSAGE,
  deriveStealthKeys,
  deriveMetaAddress,
  announcementIsMine,
  type StealthKeys,
  type ScannableAnnouncement,
} from '@/lib/stealth'

export interface DetectedPayment {
  stealthAddress:  `0x${string}`
  amountRaw:       bigint          // current USDC balance at the stealth address
  ephemeralPubKey: `0x${string}`
  txHash:          string
  blockNumber:     number
  // Too small to ever claim: on Arc the gas reserve would exceed the amount.
  // Typically the remainder left behind by a previous claim's gas reservation.
  isDust:          boolean
}

/** Per-payment result of a batch claim. Failures never abort the run. */
export interface ClaimAllOutcome {
  payment: DetectedPayment
  ok:      boolean
  error?:  string
}

export interface ClaimAllProgress {
  /** 1-based position of the payment now being claimed, so `position of total` reads correctly. */
  position: number
  total:    number
  current:  DetectedPayment
}

interface AnnouncementApiRow {
  scheme_id: number
  stealth_address: string
  caller: string
  ephemeral_pub_key: string
  metadata: string
  block_number: number
  tx_hash: string
  log_index: number
}

// In-memory only, per address. Spending keys are NEVER persisted or transmitted
// (Bottleneck 7); a page refresh clears them and the user re-derives by signing.
const keyCache = new Map<string, { keys: StealthKeys; metaAddress: `0x${string}` }>()

const ANNOUNCE_PAGE = 500
// Hard bound on scan pages so a misbehaving hasMore can never loop forever
// (500 × 400 = 200k announcements, far beyond testnet volume).
const MAX_SCAN_PAGES = 400

export function useStealth() {
  const { address }            = useAccount()
  const { signMessageAsync }   = useSignMessage()
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy]        = useState(false)

  // Derive (and cache) the user's stealth keys + meta-address from one signature.
  const unlock = useCallback(async (): Promise<{ keys: StealthKeys; metaAddress: `0x${string}` }> => {
    if (!address) throw new Error('Connect your wallet first')
    const cached = keyCache.get(address)
    if (cached) return cached
    const signature = await signMessageAsync({ message: STEALTH_KEYGEN_MESSAGE }) as `0x${string}`
    const keys = deriveStealthKeys(signature)
    const metaAddress = deriveMetaAddress(signature)
    const entry = { keys, metaAddress }
    keyCache.set(address, entry)
    return entry
  }, [address, signMessageAsync])

  // Enable private payments: derive keys, verify signature determinism, publish
  // the meta-address on-chain (ERC-6538 Registry) and off-chain (stealth_meta).
  const enablePrivacy = useCallback(async (): Promise<`0x${string}`> => {
    if (!address) throw new Error('Connect your wallet first')
    setBusy(true)
    try {
      // Determinism guard: a wallet whose signatures are non-deterministic would
      // derive different keys each time and strand funds. Sign twice, compare.
      const sig1 = await signMessageAsync({ message: STEALTH_KEYGEN_MESSAGE }) as `0x${string}`
      const sig2 = await signMessageAsync({ message: STEALTH_KEYGEN_MESSAGE }) as `0x${string}`
      if (sig1 !== sig2) {
        throw new Error('Your wallet produced different signatures for the same message, so stealth keys cannot be recovered reliably. Private payments are not supported for this wallet.')
      }
      const keys = deriveStealthKeys(sig1)
      const metaAddress = deriveMetaAddress(sig1)
      keyCache.set(address, { keys, metaAddress })

      // Publish on-chain (canonical, durable).
      const registry = getRegistryContract()
      const tx = await writeContractAsync({
        address: registry, abi: registryAbi, functionName: 'registerKeys',
        args: [STEALTH_SCHEME_ID, metaAddress],
      })
      await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })

      // Publish off-chain (fast pay-page lookup), authed by a wallet signature.
      const regSig = await signMessageAsync({ message: buildStealthRegisterMessage(address, metaAddress) })
      const r = await fetch('/api/stealth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, metaAddress, signature: regSig }),
      })
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error as string) || 'Failed to register meta-address')
      return metaAddress
    } finally {
      setBusy(false)
    }
  }, [address, signMessageAsync, writeContractAsync])

  // Scan every announcement locally with the viewing key, then read the balance
  // at each stealth address that belongs to the user.
  const scan = useCallback(async (): Promise<DetectedPayment[]> => {
    const { keys } = await unlock()
    // Bring the announcement index up to chain head first. Without this a payment
    // that already landed stays invisible until the daily cron runs - and on
    // preview deployments Vercel never runs crons at all, so it would never
    // appear. A sync failure must not silently report "no payments": surface it.
    const sync = await fetch('/api/stealth/sync', { method: 'POST' })
    if (!sync.ok) throw new Error('Could not sync with the chain. Please try again.')
    const mine: AnnouncementApiRow[] = []
    let offset = 0
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const res = await fetch(`/api/stealth/announcements?limit=${ANNOUNCE_PAGE}&offset=${offset}`)
      if (!res.ok) throw new Error('Failed to load announcements')
      const body = await res.json() as { data: AnnouncementApiRow[]; hasMore: boolean; nextOffset: number }
      for (const row of body.data) {
        const ann: ScannableAnnouncement = {
          stealthAddress:  row.stealth_address as `0x${string}`,
          ephemeralPubKey: row.ephemeral_pub_key as `0x${string}`,
          metadata:        row.metadata as `0x${string}`,
        }
        if (announcementIsMine(ann, keys)) mine.push(row)
      }
      if (!body.hasMore || body.data.length === 0) break
      offset = body.nextOffset
    }
    if (mine.length === 0) return []

    // Read current balances in one multicall; only surface addresses still holding funds.
    const balances = await publicClient.multicall({
      contracts: mine.map((m) => ({
        address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [m.stealth_address as `0x${string}`],
      } as const)),
      allowFailure: true,
    })
    // One gas-price read for the whole scan: the dust line is the point where the
    // claim's own gas reserve would swallow the payment, so it moves with gas.
    const reserveRaw = claimReserveRaw(await gasPriceWei())

    const out: DetectedPayment[] = []
    mine.forEach((m, i) => {
      const res = balances[i]
      const bal = res?.status === 'success' && typeof res.result === 'bigint' ? res.result : 0n
      if (bal > 0n) {
        out.push({
          stealthAddress:  m.stealth_address as `0x${string}`,
          amountRaw:       bal,
          ephemeralPubKey: m.ephemeral_pub_key as `0x${string}`,
          txHash:          m.tx_hash,
          blockNumber:     m.block_number,
          isDust:          isDustAmount(bal, reserveRaw),
        })
      }
    })
    return out
  }, [unlock])

  // Claim a detected payment into the recipient's account. Computes the one-time
  // stealth private key from the user's own keys (app-signed, no wallet popups),
  // then either routes through buckets (Quick) or distributes directly (Private).
  const claim = useCallback(async (
    payment: DetectedPayment,
    mode: 'quick' | 'private',
  ): Promise<QuickClaimResult | PrivateClaimResult> => {
    if (!address) throw new Error('Connect your wallet first')
    const { keys } = await unlock()
    const stealthPrivateKey = computeStealthPrivateKey({
      ephemeralPublicKey: payment.ephemeralPubKey,
      spendingPrivateKey: keys.spendingPrivateKey,
      viewingPrivateKey:  keys.viewingPrivateKey,
    })

    if (mode === 'quick') {
      return quickClaim({ stealthPrivateKey, mainAddress: address })
    }

    // Private Claim needs the recipient's current bucket config to mirror the split.
    const raw = await publicClient.readContract({
      address: getSplitContract(), abi: splitAbi, functionName: 'getBuckets', args: [address],
    }) as readonly { bps: number; destination: `0x${string}`; active: boolean }[]
    const buckets: ClaimBucket[] = raw.map((b) => ({
      bps: Number(b.bps), destination: b.destination, active: b.active,
    }))
    return privateClaim({ stealthPrivateKey, mainAddress: address, buckets })
  }, [address, unlock])

  /**
   * Claim several payments in one action.
   *
   * Each stealth address is a separate account whose funds can only be moved by a
   * transaction signed with its own key, so this is inherently sequential - N
   * claims, not one batched transaction. Dust is skipped: claiming it is
   * guaranteed to fail, and one guaranteed failure must not stop the rest.
   *
   * A failure is recorded and the run continues. That is safe because an unclaimed
   * payment simply stays at its stealth address, still detectable by the next scan,
   * so nothing is ever stranded by stopping early.
   */
  const claimAll = useCallback(async (
    payments:    readonly DetectedPayment[],
    mode:        'quick' | 'private',
    onProgress?: (p: ClaimAllProgress) => void,
  ): Promise<ClaimAllOutcome[]> => {
    const claimable = payments.filter((p) => !p.isDust)
    const outcomes: ClaimAllOutcome[] = []
    for (const [index, payment] of claimable.entries()) {
      // Reported once per payment, as it starts. Completion of the whole run is
      // the resolved promise, so there is no second notification per item.
      onProgress?.({ position: index + 1, total: claimable.length, current: payment })
      try {
        await claim(payment, mode)
        outcomes.push({ payment, ok: true })
      } catch (e) {
        outcomes.push({ payment, ok: false, error: e instanceof Error ? e.message : 'Claim failed' })
      }
    }
    return outcomes
  }, [claim])

  return { address, busy, unlock, enablePrivacy, scan, claim, claimAll }
}
