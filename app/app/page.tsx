'use client'

import { useState, useMemo } from 'react'
import { parseUnits } from 'viem'
import { useAccount, useReadContracts, useWriteContract, useChainId, useSwitchChain } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, erc20Abi, USDC, type SplitBucket } from '@/lib/contracts'
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
import { AddBucketModal } from '@/components/add-bucket-modal'
import { WithdrawModal } from '@/components/withdraw-modal'
import { ScheduleModal } from '@/components/schedule-modal'
import { EditBucketModal } from '@/components/edit-bucket-modal'
import { GoalModal } from '@/components/goal-modal'
import { Eye, EyeOff, Copy, Download, Plus } from 'lucide-react'

const TX_TIMEOUT_MS = 30_000

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
  const { data: routedTotals } = useRoutedTotals(address)
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
  const totalBal  = buckets.reduce((sum, b) => sum + b.balance, 0n)

  const [depositStr, setDepositStr]     = useState('')
  const [depositStep, setDepositStep]   = useState<'idle' | 'switching' | 'approving' | 'depositing'>('idle')
  const [depositError, setDepositError] = useState<string | null>(null)
  const [pendingTxHash, setPendingTxHash] = useState<`0x${string}` | null>(null)
  const [modal, setModal]               = useState<ModalState>(null)
  const [hideBalances, setHideBalances] = useState(false)
  const [addOpen, setAddOpen]           = useState(false)

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

      // ── Step 2: deposit ──
      setDepositStep('depositing')
      const depositTx = await writeContractAsync({
        address:      contractAddress,
        abi:          splitAbi,
        functionName: 'deposit',
        args:         [amount],
        chainId:      arcTestnet.id,
      })
      setPendingTxHash(depositTx)
      await waitForReceiptCapped(depositTx)

      setDepositStr('')

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

              {isLoading ? (
                <div className="h-12 w-44 rounded-lg animate-pulse mt-1" style={{ background: 'var(--bg-3)' }} />
              ) : hideBalances ? (
                <p className="font-mono font-bold leading-none mt-1" style={{ fontSize: 'clamp(2rem,4vw,3rem)', color: 'var(--text)' }}>••••</p>
              ) : (
                <UsdcAmount value={totalBal} className="block font-bold leading-none text-[clamp(2rem,4vw,3rem)] mt-1" />
              )}
              <p className="font-mono" style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 6 }}>≈ ${mask(formatUsdc(totalBal))} USD</p>

              <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)', marginTop: 16 }}>Wallet balance</p>
              <div className="flex items-center gap-2" style={{ marginTop: 2 }}>
                <span className="font-mono" style={{ fontSize: 14, color: 'var(--text)' }}>{mask(formatUsdc(walletBal))} USDC</span>
                <button type="button" onClick={copyAddress} aria-label="Copy wallet address" style={{ color: 'var(--text-3)' }} className="hover:text-[var(--text)] transition-colors">
                  <Copy size={13} />
                </button>
              </div>
            </div>

            {/* Deposit row */}
            <form onSubmit={handleDeposit} className="relative flex gap-2" style={{ zIndex: 1, marginTop: 20 }}>
              <input
                type="number"
                min="0.000001"
                step="0.000001"
                placeholder="Amount to deposit"
                value={depositStr}
                onChange={(e) => setDepositStr(e.target.value)}
                className="flex-1 font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                style={{ background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '10px 14px', fontSize: 14, color: 'var(--text)' }}
              />
              <button
                type="button"
                onClick={() => void handleDeposit()}
                disabled={depositStep !== 'idle' || !parsedDepositAmount || noBuckets}
                title={noBuckets ? 'Add a bucket before depositing' : undefined}
                className="shrink-0 inline-flex items-center gap-1.5 text-white hover:opacity-[0.88] active:scale-[0.98] transition disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)', borderRadius: 10, padding: '10px 18px', fontSize: 13, fontWeight: 600 }}
              >
                <Download size={15} /> {depositLabel}
              </button>
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
                className="inline-flex items-center gap-1.5 transition-colors hover:bg-[var(--bg-3)]"
                style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 12, color: 'var(--text)', border: '0.5px solid var(--border)', borderRadius: 9, padding: '6px 12px' }}
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
                  const raw = routedTotals?.[String(b.id)]
                  return (
                    <BucketCard
                      key={String(b.id)}
                      bucket={b}
                      goal={goals?.[String(b.id)]}
                      routedTotal={raw ? BigInt(raw) : 0n}
                      iconSlug={bucketIcons?.[String(b.id)]}
                      colorIndex={index}
                      onEdit={() => setModal({ kind: 'edit', bucket: b })}
                      onWithdraw={() => setModal({ kind: 'withdraw', bucket: b })}
                      onSchedule={() => setModal({ kind: 'schedule', bucket: b })}
                      onSetGoal={() => setModal({ kind: 'goal', bucket: b })}
                      onDelete={() => { /* delete handled in /app/settings */ }}
                    />
                  )
                })}
              </div>
            )}
          </section>

          {/* Allocation overview */}
          {!noBuckets && <AllocationOverview buckets={buckets} routedTotals={routedTotals} />}
        </div>

        {/* ── RIGHT COLUMN ── */}
        <div className="flex flex-col gap-5 min-w-0 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-48px)]">
          <ActivityFeed address={address} compact />
          <InsightsCard address={address} />
        </div>
      </div>

      {addOpen && <AddBucketModal onClose={() => setAddOpen(false)} />}
      {modal?.kind === 'edit' && <EditBucketModal bucket={modal.bucket} onClose={() => setModal(null)} />}
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
