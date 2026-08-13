'use client'

import { useState, useMemo, useEffect } from 'react'
import { parseUnits } from 'viem'
import { useAccount, useReadContracts, useWriteContract, useChainId, useSwitchChain } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, erc20Abi, USDC, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { buildDepositMemo } from '@/lib/memos'
import { publicClient } from '@/lib/arc'
import { arcTestnet } from '@/lib/chain'
import { parseSplitError } from '@/lib/errors'
import { formatUsdc } from '@/lib/format'
import { useRoutedTotals } from '@/hooks/use-routed-totals'
import { useBucketIcons } from '@/hooks/use-bucket-icons'
import { UsdcAmount } from '@/components/usdc-amount'
import { TxLink } from '@/components/tx-link'
import { ActivityFeed } from '@/components/activity-feed'
import { InsightsCard } from '@/components/insights-card'
import { AllocationOverview } from '@/components/allocation-overview'
import { CoinGraphic } from '@/components/coin-graphic'
import { BucketCard } from '@/components/bucket-card'
import { useSplitTotal } from '@/hooks/use-split-total'
import { useBucketLocks } from '@/hooks/use-bucket-locks'
import { LockWithdrawModal } from '@/components/lock-withdraw-modal'
import { BucketWalletSendModal } from '@/components/bucket-wallet-send-modal'
import { useBucketWallets, type GeneratedBucketWallet } from '@/hooks/use-bucket-wallets'
import { AddBucketModal } from '@/components/add-bucket-modal'
import { WithdrawModal } from '@/components/withdraw-modal'
import { ScheduleModal } from '@/components/schedule-modal'
import { EditBucketModal } from '@/components/edit-bucket-modal'
import { GoalModal } from '@/components/goal-modal'
import { AlertTriangle, Eye, EyeOff, Copy, Download, Plus, X } from 'lucide-react'

const TX_TIMEOUT_MS = 30_000

// How long the Total in Split figure waits for its slow sources before showing
// what it has. Sized against the measured behaviour of /api/buckets/routed:
// ~0.9s warm, ~170s cold. Long enough to absorb the warm case (which is what made
// the figure visibly jump on refresh), short enough that a cold backend never
// leaves the user staring at a skeleton.
const SLOW_SOURCE_GRACE_MS = 3_000

// Wait for a receipt but never hang the UI. A pending tx or unresponsive RPC must not
// freeze the button on "Approving…"/"Depositing…" forever — Promise.race hard-caps the wait.
async function waitForReceiptCapped(hash: `0x${string}`): Promise<void> {
  await Promise.race([
    publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Confirmation is taking longer than expected — check ArcScan for the transaction status.')),
        TX_TIMEOUT_MS,
      ),
    ),
  ])
}

type ModalState =
  | { kind: 'edit';     bucket: SplitBucket }
  | { kind: 'withdraw'; bucket: SplitBucket }
  | { kind: 'schedule'; bucket: SplitBucket }
  | { kind: 'goal';     bucket: SplitBucket }
  | null

export default function DashboardPage() {
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const { writeContractAsync } = useWriteContract()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const contractAddress = getSplitContract()
  const { data: routedTotals, isPending: routedTotalsPending, isError: routedTotalsError } = useRoutedTotals(address)
  const { data: bucketIcons } = useBucketIcons(address)

  // Read-only goals fetch (same source the Buckets page uses) so cards can show the Goal badge/bar.
  const { data: goals } = useQuery({
    queryKey: ['goals', address],
    queryFn: async (): Promise<Record<string, bigint>> => {
      if (!address) return {}
      const r = await fetch(`/api/goals?address=${encodeURIComponent(address)}`)
      if (!r.ok) return {}
      const body = (await r.json()) as { data?: Array<{ bucket_id: string; target_amount: string }> }
      const map: Record<string, bigint> = {}
      for (const g of body.data ?? []) {
        try {
          const key = String(BigInt(g.bucket_id))
          const amt = BigInt(g.target_amount)
          if (amt > 0n) map[key] = amt
        } catch { /* skip malformed row */ }
      }
      return map
    },
    enabled: !!address,
    staleTime: 30_000,
  })

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      { address: contractAddress, abi: splitAbi, functionName: 'getBuckets',  args: [address!] },
      { address: USDC,            abi: erc20Abi, functionName: 'balanceOf',   args: [address!] },
      { address: USDC,            abi: erc20Abi, functionName: 'allowance',   args: [address!, contractAddress] },
    ],
    query: { enabled: !!address, refetchInterval: 30_000 },
  })

  const buckets        = (data?.[0]?.result ?? []) as SplitBucket[]
  const walletBal      = (data?.[1]?.result ?? 0n) as bigint
  const allowance      = (data?.[2]?.result ?? 0n) as bigint
  const [depositStr, setDepositStr]     = useState('')
  const [noteStr, setNoteStr]           = useState('')
  const [depositStep, setDepositStep]   = useState<'idle' | 'switching' | 'approving' | 'depositing'>('idle')
  const [depositError, setDepositError] = useState<string | null>(null)
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | null>(null)
  const [modal, setModal]               = useState<ModalState>(null)
  const [pendingDelete, setPendingDelete] = useState<SplitBucket | null>(null)
  const [deleting, setDeleting] = useState<bigint | null>(null)
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null)
  const [hideBalances, setHideBalances] = useState(false)
  const [addOpen, setAddOpen]           = useState(false)

  // Which buckets have an app-generated destination. A display hint only: it needs
  // no signature, and nothing here is trusted when money moves (a send re-derives
  // the key and checks it against the bucket's on-chain destination first).
  const bucketWallets = useBucketWallets()
  const [generatedWallets, setGeneratedWallets] = useState<GeneratedBucketWallet[]>([])
  const [sendWallet, setSendWallet] = useState<
    { bucketName: string; derivationIndex: number; walletAddress: `0x${string}` } | null
  >(null)
  // Resolved, not "found something": the Total in Split figure waits on this, so
  // it must flip even when the lookup fails or returns nothing. Otherwise a user
  // with no generated wallets would sit on the skeleton forever.
  const [generatedWalletsResolved, setGeneratedWalletsResolved] = useState(false)
  const listGenerated = bucketWallets.listGenerated
  useEffect(() => {
    let alive = true
    void listGenerated()
      .then((w) => { if (alive) setGeneratedWallets(w) })
      .catch(() => { /* hint only: the dashboard still renders without it */ })
      .finally(() => { if (alive) setGeneratedWalletsResolved(true) })
    return () => { alive = false }
    // Depends on the stable `listGenerated` callback, not the hook's return object,
    // which is a fresh literal every render and would re-fire this on each one.
  }, [listGenerated])

  // Private Claims transfer directly to generated bucket wallets and do not emit
  // Split BucketSplit events. Read those dedicated wallets' live USDC balances.
  const generatedAddresses = useMemo(
    () => generatedWallets.map((w) => w.walletAddress as `0x${string}`),
    [generatedWallets],
  )
  const { data: generatedBalanceByAddress = new Map<string, bigint>(), isLoading: generatedBalancesLoading } = useQuery({
    queryKey: ['generated-wallet-balances', generatedAddresses],
    enabled: generatedAddresses.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const results = await publicClient.multicall({
        contracts: generatedAddresses.map((wallet) => ({
          address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [wallet],
        } as const)),
        allowFailure: true,
      })
      const out = new Map<string, bigint>()
      generatedAddresses.forEach((wallet, i) => {
        const result = results[i]
        if (result?.status === 'success' && typeof result.result === 'bigint') {
          out.set(wallet.toLowerCase(), result.result)
        }
      })
      return out
    },
  })

  // Classify destinations that are BucketLocks. Four checks, all required, and
  // failing closed: trusted factory, owner == this user, right token, right
  // chain. `isLock` alone proves provenance, never ownership.
  const lockDestinations = useMemo(
    () => buckets.filter((b) => b.destination !== ZERO_ADDRESS).map((b) => b.destination),
    [buckets],
  )
  const { classified: lockMap, factoryValid: lockFactoryValid, loadOrphans } = useBucketLocks(lockDestinations)

  const [withdrawLock, setWithdrawLock] = useState<
    { bucketName: string; address: `0x${string}`; state: NonNullable<ReturnType<typeof lockMap.get>>['state']; unlockedNow: boolean } | null
  >(null)

  // Match every card's source: contract balance for holds, live balance for
  // dedicated generated wallets, and cumulative events for other destinations.
  // Distinct eligible lock balances are added ONCE, outside the per-bucket
  // reduce. Two buckets can point at the same lock (Split does not prevent it),
  // and adding it per bucket would double-count a single balance.
  const countedLocks = new Set<string>()
  const bucketTotal = buckets.reduce((sum, b) => {
    if (b.destination === ZERO_ADDRESS) return sum + b.balance
    const key = b.destination.toLowerCase()

    const lock = lockMap.get(key)
    if (lock && (lock.classification === 'ELIGIBLE' || lock.classification === 'CONFLICT')) {
      if (countedLocks.has(key)) return sum       // already counted this lock
      countedLocks.add(key)
      return sum + (lock.state?.balance ?? 0n)
    }
    // FOREIGN, UNSUPPORTED and UNAVAILABLE contribute nothing: they are not this
    // user's spendable money, or could not be verified at all.
    if (lock && lock.classification !== 'ORDINARY') return sum

    const generatedBalance = generatedBalanceByAddress.get(key)
    if (generatedBalance !== undefined) return sum + generatedBalance
    const routed = routedTotals?.[String(b.id)]
    return sum + (routed ? BigInt(routed) : 0n)
  }, 0n)
  const hasDestinationBuckets = buckets.some((b) => b.destination !== ZERO_ADDRESS)
  const bucketTotalPartial = hasDestinationBuckets && (routedTotalsPending || routedTotalsError)
  const { total: totalBal, isPartial, vaultLocked } = useSplitTotal(bucketTotal, bucketTotalPartial)

  // The total is assembled from sources that land at very different speeds: hold
  // balances arrive in one contract read, while an auto-send bucket's figure comes
  // from a history scan. Rendering as soon as the fastest one lands counted the
  // slow ones as zero, so the figure appeared low and then visibly jumped.
  //
  // Waiting for them is the fix, but waiting UNCONDITIONALLY is not: measured on
  // this project's own endpoint, that scan answers in 0.9s against a warm cache
  // and 170s against a cold one. An unbounded wait would trade a two-second jump
  // for a three-minute skeleton. So the wait is bounded - past the grace period we
  // show what we have and label it, which the `isPartial` notice below already does.
  //
  // The Vault is excluded entirely: it needs a wallet signature and may never be
  // unlocked, so it could never satisfy a wait.
  const [graceElapsed, setGraceElapsed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setGraceElapsed(true), SLOW_SOURCE_GRACE_MS)
    return () => clearTimeout(t)
  }, [])

  const slowSourcesPending =
    (hasDestinationBuckets && routedTotalsPending && !routedTotalsError) ||
    !generatedWalletsResolved ||
    generatedBalancesLoading

  // `isLoading` stays unbounded on purpose: it is the bucket list itself, so
  // without it there is no figure to show at all, only a confident zero.
  const totalPending = isLoading || (!graceElapsed && slowSourcesPending)

  // Returns null for empty/invalid input — caller treats null as "not ready"
  const parsedDepositAmount = useMemo<bigint | null>(() => {
    if (!depositStr.trim()) return null
    try { return parseUnits(depositStr.trim(), 6) }
    catch { return null }
  }, [depositStr])

  const noBuckets = buckets.length === 0

  const depositLabel =
    depositStep === 'switching'                                     ? 'Switching network…'
    : depositStep === 'approving'                                   ? 'Approving…'
    : depositStep === 'depositing'                                  ? 'Depositing…'
    : parsedDepositAmount && allowance >= parsedDepositAmount       ? 'Deposit'
    : 'Approve & deposit'

  async function handleDeposit(e?: React.FormEvent) {
    e?.preventDefault()
    setDepositError(null)

    // Capture at call-time — prevents stale closure if depositStr changes mid-transaction
    const amount = parsedDepositAmount
    if (!amount)           { setDepositError('Enter a valid USDC amount.'); return }
    if (amount === 0n)     { setDepositError('Amount must be greater than zero.'); return }
    if (amount > walletBal){ setDepositError('Amount exceeds wallet balance.'); return }

    try {
      // A wallet on the wrong network is a silent failure — writes never reach Arc.
      // Switch first so the deposit can't no-op (or get swallowed) against the wrong chain.
      if (chainId !== arcTestnet.id) {
        setDepositStep('switching')
        await switchChainAsync({ chainId: arcTestnet.id })
      }

      // ── Step 1: approve if current allowance is insufficient ──
      if (allowance < amount) {
        setDepositStep('approving')
        const approveTx = await writeContractAsync({
          address:      USDC,
          abi:          erc20Abi,
          functionName: 'approve',
          args:         [contractAddress, amount],
          chainId:      arcTestnet.id,
        })
        // Show hash immediately — user can verify on ArcScan while confirmation arrives
        setPendingTxHash(approveTx)
        await waitForReceiptCapped(approveTx)
      }

      // ── Step 2: deposit (wrapped in Memo if note provided) ──
      setDepositStep('depositing')
      const memoArgs = buildDepositMemo(amount, noteStr)
      const depositTx = memoArgs
        ? await writeContractAsync({ ...memoArgs, chainId: arcTestnet.id })
        : await writeContractAsync({ address: contractAddress, abi: splitAbi, functionName: 'deposit', args: [amount], chainId: arcTestnet.id })
      setPendingTxHash(depositTx)
      await waitForReceiptCapped(depositTx)

      setDepositStr('')
      setNoteStr('')

      // address is always defined here — guarded by the `if (!address) return null` above
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ['buckets', address] }),
        queryClient.invalidateQueries({ queryKey: ['activity', address] }),
        refetch(),
      ])
    } catch (err) {
      // Surface the real reason — never swallow it. A capped-wait timeout carries its own
      // user-facing message; everything else is mapped to a friendly string.
      const message =
        err instanceof Error && err.message.startsWith('Confirmation is taking longer')
          ? err.message
          : parseSplitError(err)
      setDepositError(message)
    } finally {
      // Always reset — the button must never stay stuck on a busy label.
      setDepositStep('idle')
      setPendingTxHash(null)
    }
  }

  function requestDelete(bucket: SplitBucket) {
    if (bucket.balance > 0n) {
      setDeleteNotice(`Withdraw the remaining ${formatUsdc(bucket.balance)} USDC from “${bucket.name}” before deleting it.`)
      return
    }
    setDeleteNotice(null)
    setPendingDelete(bucket)
  }

  async function confirmDelete(bucket: SplitBucket) {
    setPendingDelete(null)
    setDeleting(bucket.id)
    setDeleteNotice(null)

    try {
      const latestBuckets = await publicClient.readContract({
        address: contractAddress,
        abi: splitAbi,
        functionName: 'getBuckets',
        args: [address!],
      }) as readonly SplitBucket[]
      const latestBucket = latestBuckets.find((candidate) => candidate.id === bucket.id)

      if (!latestBucket) {
        setDeleteNotice('This bucket no longer exists. Refreshing your dashboard now.')
        await refetch()
        return
      }
      if (latestBucket.balance > 0n) {
        setDeleteNotice(`Withdraw the remaining ${formatUsdc(latestBucket.balance)} USDC from “${latestBucket.name}” before deleting it.`)
        await refetch()
        return
      }
      if (chainId !== arcTestnet.id) {
        await switchChainAsync({ chainId: arcTestnet.id })
      }

      const hash = await writeContractAsync({
        address: contractAddress,
        abi: splitAbi,
        functionName: 'deleteBucket',
        args: [bucket.id],
        chainId: arcTestnet.id,
      })
      await waitForReceiptCapped(hash)
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ['buckets', address] }),
        queryClient.invalidateQueries({ queryKey: ['activity', address] }),
        refetch(),
      ])
    } catch (err) {
      const message = err instanceof Error && err.message.startsWith('Confirmation is taking longer')
        ? err.message
        : parseSplitError(err)
      setDeleteNotice(message)
    } finally {
      setDeleting(null)
    }
  }

  if (!address) return null

  const copyAddress = () => { if (address) void navigator.clipboard?.writeText(address) }
  const mask = (s: string) => (hideBalances ? '••••' : s)

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        {/* ── LEFT COLUMN ── */}
        <div className="flex flex-col gap-5 min-w-0">
          {/* Total in Split card */}
          <section className="relative overflow-hidden" style={{ background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 16, padding: 24 }}>
            <CoinGraphic className="hidden sm:block absolute top-1 right-1 w-40 h-40 pointer-events-none" />

            <div className="relative" style={{ zIndex: 1 }}>
              <div className="flex items-center gap-2">
                <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-2)' }}>Total in Split</p>
                <button type="button" onClick={() => setHideBalances((v) => !v)} aria-label={hideBalances ? 'Show balances' : 'Hide balances'} style={{ color: 'var(--text-3)' }}>
                  {hideBalances ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>

              {totalPending ? (
                <>
                  <div className="h-12 w-44 rounded-lg animate-pulse mt-1" style={{ background: 'var(--bg-3)' }} />
                  <div className="h-3 w-24 rounded animate-pulse" style={{ background: 'var(--bg-3)', marginTop: 9 }} />
                </>
              ) : (
                <>
                  {hideBalances ? (
                    <p className="font-mono font-bold leading-none mt-1" style={{ fontSize: 'clamp(2rem,4vw,3rem)', color: 'var(--text)' }}>••••</p>
                  ) : (
                    <UsdcAmount value={totalBal} className="block font-bold leading-none text-[clamp(2rem,4vw,3rem)] mt-1" />
                  )}
                  <p className="font-mono" style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 6 }}>≈ ${mask(formatUsdc(totalBal))} USD</p>
                </>
              )}

              {/* A locked Vault means part of the total is unknown, not zero.
                  Saying so keeps the figure honest: silently omitting the Vault
                  would understate the real total, which is the bug this warning
                  already exists to prevent. */}
              {!totalPending && isPartial && (
                <p role="status" aria-live="polite" style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--warning, #FBBF24)', marginTop: 6, maxWidth: 320 }}>
                  {slowSourcesPending
                    ? 'Still adding up your auto-send buckets, so this figure will rise when it finishes.'
                    : vaultLocked
                      ? 'Partial: your Private Vault is locked, so its balance is not counted yet. Open it on the Privacy page to include it.'
                      : 'Partial: some balances could not be read just now.'}
                </p>
              )}

              <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)', marginTop: 16 }}>Wallet balance</p>
              <div className="flex items-center gap-2" style={{ marginTop: 2 }}>
                <span className="font-mono" style={{ fontSize: 14, color: 'var(--text)' }}>{mask(formatUsdc(walletBal))} USDC</span>
                <button type="button" onClick={copyAddress} aria-label="Copy wallet address" style={{ color: 'var(--text-3)' }} className="hover:text-[var(--text)] transition-colors">
                  <Copy size={13} />
                </button>
              </div>
            </div>

            {/* Deposit row */}
            <form onSubmit={handleDeposit} className="relative flex flex-col gap-2" style={{ zIndex: 1, marginTop: 20 }}>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  placeholder="Amount to deposit"
                  value={depositStr}
                  onChange={(e) => setDepositStr(e.target.value)}
                  className="flex-1 min-w-0 font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  style={{ background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '10px 14px', fontSize: 14, color: 'var(--text)' }}
                />
                <button
                  type="button"
                  onClick={() => void handleDeposit()}
                  disabled={depositStep !== 'idle' || !parsedDepositAmount || noBuckets}
                  title={noBuckets ? 'Add a bucket before depositing' : undefined}
                  className="shrink-0 inline-flex items-center gap-1.5 text-white hover:opacity-[0.88] active:scale-[0.98] transition disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600 }}
                >
                  <Download size={15} /> {depositLabel}
                </button>
              </div>
              <input
                type="text"
                placeholder="Add a note (optional) — invoice ref, project name…"
                value={noteStr}
                onChange={(e) => setNoteStr(e.target.value)}
                className="w-full font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                style={{ background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '10px 14px', fontSize: 13, color: 'var(--text)' }}
              />
            </form>

            {noBuckets && (
              <p className="relative mt-3 text-xs" style={{ zIndex: 1, color: 'var(--warning)' }}>
                Add a bucket below before depositing.
              </p>
            )}
            {pendingTxHash && (
              <p className="relative mt-3 text-xs flex items-center gap-1.5" style={{ zIndex: 1, color: 'var(--text-2)' }}>
                <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse shrink-0" style={{ background: 'var(--accent)' }} aria-hidden="true" />
                {depositStep === 'approving' ? 'Approving…' : 'Depositing…'}{' '}
                <TxLink hash={pendingTxHash} />
              </p>
            )}
            {depositError && (
              <p className="relative mt-3 text-sm" style={{ zIndex: 1, color: 'var(--danger)' }} role="alert">{depositError}</p>
            )}
          </section>

          {/* Buckets card */}
          <section style={{ background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 16, padding: 20 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 16 }}>
              <h2 style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>Buckets</h2>
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="inline-flex items-center gap-1.5 transition-colors hover:bg-[var(--accent-bg-hover)]"
                style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 12, color: 'var(--accent)', background: 'var(--accent-bg)', border: '1px solid var(--accent-border)', borderRadius: 9, padding: '7px 12px' }}
              >
                <Plus size={14} /> New Bucket
              </button>
            </div>

            {isLoading ? (
              <div className="bucket-grid">
                {(['skel-a', 'skel-b'] as const).map((k) => (
                  <div key={k} className="h-52 rounded-xl animate-pulse" style={{ background: 'var(--bg-3)' }} />
                ))}
              </div>
            ) : noBuckets ? (
              <div className="text-center" style={{ border: '0.5px dashed var(--border)', borderRadius: 12, padding: 32 }}>
                <p style={{ fontSize: 14, color: 'var(--text-3)' }}>No buckets yet.</p>
                <button type="button" onClick={() => setAddOpen(true)} className="inline-block mt-2 hover:opacity-80 transition-opacity" style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent)' }}>
                  Add your first bucket →
                </button>
              </div>
            ) : (
              <div className="bucket-grid">
                {buckets.map((b, index) => {
                  const liveGeneratedBalance = generatedBalanceByAddress.get(b.destination.toLowerCase())
                  const raw = liveGeneratedBalance !== undefined
                    ? String(liveGeneratedBalance)
                    : routedTotals?.[String(b.id)]
                  // Matched on the CHAIN destination, not on the bucket id alone, so
                  // a stale hint row cannot attach the send action to the wrong
                  // address. sendFrom re-derives and re-checks before moving funds.
                  const gen = generatedWallets.find(
                    (g) => g.walletAddress.toLowerCase() === b.destination.toLowerCase(),
                  )
                  return (
                    <div key={String(b.id)} className="relative">
                      {deleting === b.id && (
                        <div className="bucket-delete-overlay" role="status" aria-live="polite">
                          <span>Deleting bucket…</span>
                        </div>
                      )}

                      {pendingDelete?.id === b.id && (
                        <div className="bucket-delete-overlay" role="dialog" aria-modal="true" aria-labelledby={`delete-bucket-${String(b.id)}`}>
                          <div className="bucket-delete-dialog">
                            <p id={`delete-bucket-${String(b.id)}`} className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                              Delete “{b.name}”?
                            </p>
                            <p style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.5 }}>
                              This removes the bucket and its rules. This action cannot be undone.
                            </p>
                            <div className="flex justify-end gap-2">
                              <button type="button" className="bucket-dialog-cancel" onClick={() => setPendingDelete(null)}>Cancel</button>
                              <button type="button" className="bucket-dialog-delete" onClick={() => void confirmDelete(b)}>Delete</button>
                            </div>
                          </div>
                        </div>
                      )}

                      <BucketCard
                        bucket={b}
                        lock={(() => {
                          const l = lockMap.get(b.destination.toLowerCase())
                          if (!l) return undefined
                          return {
                            classification: l.classification,
                            balance:        l.state?.balance,
                            unlockedNow:    l.unlockedNow,
                            unlockAt:       l.state?.unlockAt,
                            target:         l.state?.target,
                            targetMet:      l.state?.targetMet,
                          }
                        })()}
                        onWithdrawLock={(() => {
                          const l = lockMap.get(b.destination.toLowerCase())
                          if (!l || l.classification !== 'ELIGIBLE' || !l.state) return undefined
                          return () => setWithdrawLock({
                            bucketName:  b.name,
                            address:     l.address,
                            state:       l.state,
                            unlockedNow: l.unlockedNow,
                          })
                        })()}
                        goal={goals?.[String(b.id)]}
                        isGenerated={!!gen}
                        isPrimary={b.destination.toLowerCase() === address.toLowerCase()}
                        onSendFromWallet={gen ? () => setSendWallet({
                          bucketName: b.name,
                          derivationIndex: gen.derivationIndex,
                          walletAddress: b.destination,
                        }) : undefined}
                        routedTotal={raw ? BigInt(raw) : 0n}
                        iconSlug={bucketIcons?.[String(b.id)]}
                        colorIndex={index}
                        onEdit={() => setModal({ kind: 'edit', bucket: b })}
                        onWithdraw={() => setModal({ kind: 'withdraw', bucket: b })}
                        onSchedule={() => setModal({ kind: 'schedule', bucket: b })}
                        onSetGoal={() => setModal({ kind: 'goal', bucket: b })}
                        onDelete={() => requestDelete(b)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Allocation overview */}
          {!noBuckets && <AllocationOverview buckets={buckets} routedTotals={routedTotals} />}
        </div>

        {/* ── RIGHT COLUMN ── */}
        {/* `top-0`, not `top-6`: the sticky offset is measured from inside <main>'s
            own 24px padding, so a 24px offset pushed this column 24px lower than
            the Total in Split card even with the page scrolled to the very top.
            Zero lines the two cards up at rest and still pins on scroll. */}
        <div className="flex flex-col gap-5 min-w-0 lg:sticky lg:top-0 lg:self-start lg:max-h-[calc(100vh-48px)]">
          <ActivityFeed address={address} compact />
          {/* Never shrink Insights: the column is height-capped, so something has
              to absorb the difference, and the Activity feed is the one built to
              (it scrolls). Letting Insights shrink instead squashed its content. */}
          <div className="lg:shrink-0">
            <InsightsCard address={address} />
          </div>
        </div>
      </div>

      {addOpen && <AddBucketModal onClose={() => setAddOpen(false)} />}

      {withdrawLock?.state && (
        <LockWithdrawModal
          bucketName={withdrawLock.bucketName}
          lockAddress={withdrawLock.address}
          state={withdrawLock.state}
          unlockedNow={withdrawLock.unlockedNow}
          onClose={() => setWithdrawLock(null)}
          onWithdrawn={() => {
            void queryClient.invalidateQueries({ queryKey: ['locks'] })
            void queryClient.invalidateQueries({ queryKey: ['activity', address] })
            void refetch()
          }}
        />
      )}

      {deleteNotice && (
        <div className="bucket-delete-toast" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <p>{deleteNotice}</p>
          <button type="button" onClick={() => setDeleteNotice(null)} aria-label="Dismiss notification">
            <X size={17} />
          </button>
        </div>
      )}

      {sendWallet && (
        <BucketWalletSendModal
          bucketName={sendWallet.bucketName}
          derivationIndex={sendWallet.derivationIndex}
          walletAddress={sendWallet.walletAddress}
          onClose={() => setSendWallet(null)}
          onSent={() => { void refetch() }}
        />
      )}
      {modal?.kind === 'edit' && (
        <EditBucketModal
          bucket={modal.bucket}
          // UI guard only: updateBucket has no such check on the immutable Split
          // contract, so a direct call can still re-point a locked bucket.
          destinationLocked={(() => {
            const l = lockMap.get(modal.bucket.destination.toLowerCase())
            return l?.classification === 'ELIGIBLE' && !l.unlockedNow
          })()}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'withdraw' && <WithdrawModal bucket={modal.bucket} onClose={() => setModal(null)} />}
      {modal?.kind === 'schedule' && <ScheduleModal bucket={modal.bucket} onClose={() => setModal(null)} />}
      {modal?.kind === 'goal' && (
        <GoalModal
          bucket={modal.bucket}
          currentGoal={goals?.[String(modal.bucket.id)]}
          onClose={() => setModal(null)}
          onSaved={(bucketId, newGoal) => {
            queryClient.setQueryData(['goals', address], (old: Record<string, bigint> | undefined) => ({
              ...(old ?? {}),
              [bucketId]: newGoal,
            }))
            setModal(null)
          }}
        />
      )}
    </>
  )
}
