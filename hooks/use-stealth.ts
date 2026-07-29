'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, useSignMessage, useSignTypedData, useWriteContract } from 'wagmi'
import { publicClient } from '@/lib/arc'
import { USDC, erc20Abi, getSplitContract, splitAbi } from '@/lib/contracts'
import {
  computeStealthPrivateKey,
  quickClaim,
  privateClaim,
  gasPriceWei,
  type QuickClaimResult,
  type PrivateClaimResult,
  sweepVaultToMain,
  isTransientRpcError,
} from '@/lib/stealth-claim'
import { claimReserveRaw, isDustAmount, computeClaimPlan, type ClaimBucket } from '@/lib/claim-math'
import { arcTestnet } from '@/lib/chain'
import {
  vaultTypedData,
  deriveVaultAddress,
  deriveVaultKey,
  vaultAddressFromKey,
  assertDeterministicSignature,
  assertVaultAddressMatches,
} from '@/lib/vault'
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

// Private Vault, same discipline and for a stronger reason: see the HARD RULE in
// lib/vault.ts. The address must never leave this session - persisting the
// main-address -> Vault mapping anywhere would let an observer watch the user's
// claimed private income, recreating the exact link the private path removes.
// Deliberately a plain Map, not localStorage or any store that outlives the tab.
const vaultCache = new Map<string, { vaultAddress: `0x${string}`; privateKey: `0x${string}` }>()

// Each sync request advances a bounded slice of blocks, so a long-neglected
// index needs several. Bounded so a permanently-lagging index cannot spin
// forever; on exhaustion the scan proceeds with whatever is indexed so far.
const MAX_SYNC_ROUNDS = 10

// A single claim costs roughly a dozen RPC calls (gas price, two writes, two
// receipt waits, a balance read, an estimate), so claiming several in a row is a
// burst that metered RPCs reject with "request limit reached". These space the
// calls out and retry a throttled claim instead of reporting it as failed, which
// previously left funds unclaimed on a run that was only being rate-limited.
const CLAIM_SPACING_MS   = 1_500
const CLAIM_RETRY_LIMIT  = 3
const CLAIM_BACKOFF_MS   = 4_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Transient-failure detection lives in lib/stealth-claim so the executor's receipt
// polling and this outer retry share one definition. They previously diverged:
// this copy matched only throttling, missing the timeouts and dropped connections
// that also strand a claim.
const isRateLimited = isTransientRpcError

const ANNOUNCE_PAGE = 500
// Hard bound on scan pages so a misbehaving hasMore can never loop forever
// (500 × 400 = 200k announcements, far beyond testnet volume).
const MAX_SCAN_PAGES = 400

export function useStealth() {
  const { address }            = useAccount()
  const { signMessageAsync }   = useSignMessage()
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy]        = useState(false)
  // Mirrors vaultCache so unlocking re-renders the UI. The Map is the source of
  // truth (it survives remounts); this is the reactive view of it. Session only.
  const [vaultAddress, setVaultAddress] = useState<`0x${string}` | null>(null)

  // Re-sync when the connected account changes, so switching wallets never shows
  // the previous account's Vault.
  useEffect(() => {
    setVaultAddress(address ? vaultCache.get(address)?.vaultAddress ?? null : null)
  }, [address])

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
    //
    // One request only advances a bounded slice (the RPC caps getLogs spans and
    // the route has a time budget), so keep going until it reports reaching head.
    for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
      const res = await fetch('/api/stealth/sync', { method: 'POST' })
      if (!res.ok) throw new Error('Could not sync with the chain. Please try again.')
      const body = await res.json() as { data?: { caughtUp?: boolean } }
      if (body.data?.caughtUp) break
      // Still behind after the last allowed round: scan what is indexed rather
      // than failing outright. Results are partial but real, and the cursor has
      // advanced, so the next scan resumes instead of starting over.
    }
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

  // Read the user's live bucket config, which Private Claim mirrors off-contract.
  const readBuckets = useCallback(async (): Promise<ClaimBucket[]> => {
    if (!address) throw new Error('Connect your wallet first')
    const raw = await publicClient.readContract({
      address: getSplitContract(), abi: splitAbi, functionName: 'getBuckets', args: [address],
    }) as readonly { bps: number; destination: `0x${string}`; active: boolean }[]
    return raw.map((b) => ({ bps: Number(b.bps), destination: b.destination, active: b.active }))
  }, [address])

  /**
   * Derive (and session-cache) the Private Vault. Signs TWICE and compares: a
   * wallet whose signatures are not deterministic would derive a different Vault
   * on a later visit and strand whatever was sent to the first one, so this is
   * checked before any funds can be routed there, not after.
   *
   * Costs two wallet popups on first use per session, then nothing. Nothing here
   * is persisted or transmitted - see the HARD RULE in lib/vault.ts.
   */
  const unlockVault = useCallback(async (): Promise<`0x${string}`> => {
    if (!address) throw new Error('Connect your wallet first')
    const cached = vaultCache.get(address)
    if (cached) return cached.vaultAddress

    const typedData = vaultTypedData(arcTestnet.id)
    const sigA = await signTypedDataAsync(typedData) as `0x${string}`
    const sigB = await signTypedDataAsync(typedData) as `0x${string}`
    assertDeterministicSignature(sigA, sigB)

    const entry = { vaultAddress: deriveVaultAddress(sigA), privateKey: deriveVaultKey(sigA) }
    vaultCache.set(address, entry)
    setVaultAddress(entry.vaultAddress)
    return entry.vaultAddress
  }, [address, signTypedDataAsync])

  /**
   * Inspect a Private Claim before committing to it, so the UI can tell whether a
   * Vault is actually needed. Only payments with a hold portion require one, so a
   * user with purely auto-send buckets is never asked to sign for a Vault.
   */
  const previewPrivateClaim = useCallback(async (
    payment: DetectedPayment,
  ): Promise<{ holdPortionRaw: bigint; needsVault: boolean }> => {
    const buckets = await readBuckets()
    // Planned against a null Vault: whatever is deferred is precisely the portion
    // that has nowhere to go without one.
    const plan = computeClaimPlan(buckets, payment.amountRaw, null)
    return { holdPortionRaw: plan.deferredRaw, needsVault: plan.deferredRaw > 0n }
  }, [readBuckets])

  // Claim a detected payment into the recipient's account. Computes the one-time
  // stealth private key from the user's own keys (app-signed, no wallet popups),
  // then either routes through buckets (Quick) or distributes directly (Private).
  //
  // `useVault` is decided by the caller: the dialog asks the user only when a hold
  // portion exists, and a decline claims the rest rather than blocking.
  const claim = useCallback(async (
    payment: DetectedPayment,
    mode: 'quick' | 'private',
    useVault = false,
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

    const buckets = await readBuckets()
    // Only unlock the Vault when it will actually be used; otherwise the hold
    // portion is deferred at the stealth address and stays claimable later.
    const vault = useVault ? await unlockVault() : null
    return privateClaim({ stealthPrivateKey, buckets, vaultAddress: vault })
  }, [address, unlock, readBuckets, unlockVault])

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
    // Carried through per payment. Without this a bulk private claim would
    // silently defer every hold portion, while the single-claim path asks - the
    // two must not disagree about where funds go.
    useVault:    boolean,
    onProgress?: (p: ClaimAllProgress) => void,
  ): Promise<ClaimAllOutcome[]> => {
    const claimable = payments.filter((p) => !p.isDust)
    const outcomes: ClaimAllOutcome[] = []
    for (const [index, payment] of claimable.entries()) {
      // Reported once per payment, as it starts. Completion of the whole run is
      // the resolved promise, so there is no second notification per item.
      onProgress?.({ position: index + 1, total: claimable.length, current: payment })

      // Space claims apart so the run does not present as one long burst.
      if (index > 0) await sleep(CLAIM_SPACING_MS)

      let lastError = 'Claim failed'
      let claimed = false
      for (let attempt = 1; attempt <= CLAIM_RETRY_LIMIT && !claimed; attempt++) {
        try {
          await claim(payment, mode, useVault)
          claimed = true
        } catch (e) {
          // Raw RPC errors are a wall of URL and request-body noise. Say what
          // actually happened and that the funds are untouched, since a failed
          // claim reads alarmingly like lost money.
          lastError = isRateLimited(e)
            ? 'The network is rate-limiting requests right now. Nothing was sent and the payment is still waiting - try again shortly.'
            : (e instanceof Error ? e.message : 'Claim failed')
          // Only throttling is worth retrying. A revert or an underfunded
          // address fails identically on a retry, so stop and report it.
          if (!isRateLimited(e) || attempt === CLAIM_RETRY_LIMIT) break
          await sleep(CLAIM_BACKOFF_MS * attempt)
        }
      }

      outcomes.push(claimed
        ? { payment, ok: true }
        : { payment, ok: false, error: lastError })
    }
    return outcomes
  }, [claim])

  /** Live USDC balance sitting in the Vault. Requires it to be unlocked. */
  const vaultBalance = useCallback(async (): Promise<bigint> => {
    const vault = await unlockVault()
    return publicClient.readContract({
      address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [vault],
    }) as Promise<bigint>
  }, [unlockVault])

  /**
   * Step 7: move everything in the Vault to the user's main wallet.
   *
   * Deliberate and never automatic. This is the one action that publicly links the
   * Vault to the main address, and doing so can retroactively expose the Vault's
   * whole history, so the caller must confirm before invoking it.
   */
  const consolidateVault = useCallback(async (): Promise<{ txHash: `0x${string}`; amountRaw: bigint }> => {
    if (!address) throw new Error('Connect your wallet first')
    const vault = await unlockVault()
    const entry = vaultCache.get(address)
    if (!entry) throw new Error('Vault is locked')

    // Re-assert that the key still controls the address we recorded this session.
    // Costs nothing and catches a wallet that changed signing behaviour BEFORE
    // funds move, rather than after.
    assertVaultAddressMatches(vaultAddressFromKey(entry.privateKey), vault)

    return sweepVaultToMain({ vaultPrivateKey: entry.privateKey, mainAddress: address })
  }, [address, unlockVault])

  return {
    address, busy, unlock, enablePrivacy, scan, claim, claimAll,
    vaultAddress, unlockVault, previewPrivateClaim, vaultBalance, consolidateVault,
  }
}
