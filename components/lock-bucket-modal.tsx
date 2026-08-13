'use client'

import { useState, useEffect, useCallback } from 'react'
import { parseUnits, decodeEventLog } from 'viem'
import { useWriteContract, useAccount, useChainId } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { getSplitContract, splitAbi, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { publicClient } from '@/lib/arc'
import { formatUsdc } from '@/lib/format'
import { bucketLockFactoryAbi, trustedFactoryFor } from '@/lib/lock-contracts'
import { validateUnlockDate, quotePenalty, MIN_LOCK_DURATION_SECONDS } from '@/lib/lock'

// Locking an EXISTING bucket.
//
// ── This is NOT atomic and must never be described as such ───────────────────
//
// It is up to four transactions across two contracts. Split exposes no batching
// primitive and cannot be modified, so this flow GUIDES, DETECTS and RESUMES.
// It does not enforce. Every intermediate state is recoverable from on-chain
// state alone; nothing here depends on this component staying mounted.
//
// Order is `updateBucket` THEN `withdrawTo`, chosen on detectability:
//
//   update-then-sweep leaves an eligible-lock destination with balance > 0, a
//   unique on-chain signature the dashboard renders as "Finish locking".
//
//   sweep-then-update would leave a zero-destination bucket with zero balance
//   plus a funded unattached lock - indistinguishable from a fresh empty hold
//   bucket and an unrelated orphan.
//
// The residual risk of this order is that between the two transactions the old
// balance is still withdrawable from Split. That is exactly the state it was
// already in, so it is never a regression, and the card says so rather than
// claiming the money is locked.

const TX_TIMEOUT_MS = 30_000

/**
 * How many sweep passes to attempt. A deposit landing mid-sweep leaves a residue,
 * so one pass is not always enough; but this must be bounded, because a bucket
 * receiving deposits faster than we can sweep would otherwise loop forever.
 * Whatever is left after this is simply picked up by "Finish locking" later.
 */
const MAX_SWEEP_PASSES = 5

type Step = 'form' | 'cancelSchedule' | 'creating' | 'routing' | 'sweeping' | 'done'

interface Props {
  bucket: SplitBucket
  /**
   * Resume mode: the bucket already points at an eligible lock but still holds a
   * Split balance, so only the sweep is outstanding. Entered from the card's
   * "Finish locking" state, which is the on-chain signature of an interrupted
   * migration (eligible-lock destination AND bucket.balance > 0).
   */
  resumeLock?: `0x${string}`
  onClose: () => void
}

export function LockBucketModal({ bucket, resumeLock, onClose }: Props) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { writeContractAsync } = useWriteContract()
  const queryClient = useQueryClient()
  const factory = trustedFactoryFor(chainId)

  const [dateStr, setDateStr]     = useState('')
  const [targetStr, setTargetStr] = useState('')
  const [step, setStep]           = useState<Step>('form')
  const [error, setError]         = useState<string | null>(null)
  const [scheduleActive, setScheduleActive] = useState<boolean | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [swept, setSwept]         = useState(0n)

  const busy = step !== 'form' && step !== 'done'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, busy])

  /**
   * A live scheduled send is a hard blocker, not a warning.
   *
   * Verified in Split.sol: `updateBucket` writes name, bps and destination only
   * and does NOT touch scheduledSends, while `executeScheduledSend` spends
   * `bucket.balance` and sends to the SCHEDULE's own stored destination. So a
   * migrated bucket with a live schedule can have its residual balance swept to
   * the old destination by the scheduler, mid-migration, with no user action.
   */
  useEffect(() => {
    let alive = true
    if (!address) return
    void publicClient.readContract({
      address: getSplitContract(), abi: splitAbi,
      functionName: 'getScheduledSend', args: [address, bucket.id],
    }).then((s) => {
      if (alive) setScheduleActive((s as { active: boolean }).active)
    }).catch(() => { if (alive) setScheduleActive(null) })
    return () => { alive = false }
  }, [address, bucket.id])

  /** Re-read this bucket by its STABLE id. Never by array index: deleteBucket
   *  uses swap-and-pop, so indices move. */
  const freshBalance = useCallback(async (): Promise<bigint> => {
    if (!address) return 0n
    const all = await publicClient.readContract({
      address: getSplitContract(), abi: splitAbi,
      functionName: 'getBuckets', args: [address],
    }) as readonly SplitBucket[]
    return all.find((b) => b.id === bucket.id)?.balance ?? 0n
  }, [address, bucket.id])

  async function handleCancelSchedule() {
    setError(null); setStep('cancelSchedule')
    try {
      const hash = await writeContractAsync({
        address: getSplitContract(), abi: splitAbi,
        functionName: 'cancelScheduledSend', args: [bucket.id],
      })
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
      setScheduleActive(false)
      setStep('form')
    } catch {
      setError('The schedule was not cancelled. Nothing else has changed.')
      setStep('form')
    }
  }

  /** Resume an interrupted migration: the lock exists and is already the
   *  destination, so only the sweep is left. No new lock is ever created here. */
  async function handleResume() {
    setError(null)
    if (!resumeLock) return
    setStep('sweeping')
    try {
      for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
        const balance = await freshBalance()
        if (balance === 0n) break
        const hash = await writeContractAsync({
          address: getSplitContract(), abi: splitAbi,
          functionName: 'withdrawTo', args: [bucket.id, balance, resumeLock],
        })
        await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
        setSwept((s) => s + balance)
      }
      void queryClient.invalidateQueries({ queryKey: ['buckets', address] })
      void queryClient.invalidateQueries({ queryKey: ['locks'] })
      setStep('done')
    } catch {
      setError('The transfer did not complete. Your money is still in Split and still withdrawable. You can try again.')
      setStep('form')
    }
  }

  async function handleLock(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!address)  { setError('Connect your wallet first.'); return }
    if (!factory)  { setError('Locked buckets are not available on this network.'); return }
    if (scheduleActive) { setError('Cancel the scheduled send first.'); return }
    if (!dateStr)  { setError('Choose an unlock date. Locked buckets always need one.'); return }

    const unlockAt = BigInt(Math.floor(new Date(`${dateStr}T00:00:00`).getTime() / 1000))
    const nowSec   = BigInt(Math.floor(Date.now() / 1000))
    const problem  = validateUnlockDate(unlockAt, nowSec)
    if (problem === 'DateRequired')  { setError('Choose an unlock date.'); return }
    if (problem === 'UnlockTooSoon') {
      setError(`The unlock date must be at least ${Number(MIN_LOCK_DURATION_SECONDS) / 86_400} day away.`)
      return
    }

    let target = 0n
    if (targetStr.trim()) {
      try { target = parseUnits(targetStr.trim(), 6) } catch {
        setError('Enter a valid target amount, or leave it empty.'); return
      }
      if (target <= 0n) { setError('A target must be greater than zero, or leave it empty.'); return }
    }
    if (!confirmed) { setError('Confirm you understand what locking this bucket does.'); return }

    try {
      // 1. Deploy the lock.
      setStep('creating')
      const lockHash = await writeContractAsync({
        address: factory.address, abi: bucketLockFactoryAbi,
        functionName: 'createLock', args: [unlockAt, target],
      })
      const lockReceipt = await publicClient.waitForTransactionReceipt({
        hash: lockHash, pollingInterval: 500, timeout: TX_TIMEOUT_MS,
      })
      let lock: `0x${string}` | null = null
      for (const log of lockReceipt.logs) {
        try {
          const d = decodeEventLog({ abi: bucketLockFactoryAbi, data: log.data, topics: log.topics })
          if (d.eventName === 'LockCreated') { lock = (d.args as { lock: `0x${string}` }).lock; break }
        } catch { /* not a factory event */ }
      }
      if (!lock) {
        setError('Your lock was created but its address could not be read. Check Lock management before retrying, so you do not create a second one.')
        setStep('form'); return
      }

      // 2. Point future deposits at it. Deliberately BEFORE the sweep.
      setStep('routing')
      const routeHash = await writeContractAsync({
        address: getSplitContract(), abi: splitAbi,
        functionName: 'updateBucket', args: [bucket.id, bucket.name, bucket.bps, lock],
      })
      await publicClient.waitForTransactionReceipt({ hash: routeHash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })

      // 3. Sweep whatever Split still holds for this bucket.
      //
      // Re-read the balance immediately before EACH transfer rather than using a
      // figure captured when this modal opened: a deposit can land, or another
      // tab can withdraw, while the user is here. Loops because a deposit
      // arriving mid-sweep leaves a residue.
      setStep('sweeping')
      for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
        const balance = await freshBalance()
        if (balance === 0n) break
        const hash = await writeContractAsync({
          address: getSplitContract(), abi: splitAbi,
          functionName: 'withdrawTo', args: [bucket.id, balance, lock],
        })
        await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
        setSwept((s) => s + balance)
      }

      void queryClient.invalidateQueries({ queryKey: ['buckets', address] })
      void queryClient.invalidateQueries({ queryKey: ['locks'] })
      setStep('done')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Never imply nothing happened: earlier steps may well have landed, and the
      // dashboard will show exactly where this stopped.
      setError(
        /User rejected|denied/i.test(msg)
          ? 'Cancelled in your wallet. Any steps already completed are shown on your dashboard, and you can pick up from there.'
          : 'That step did not complete. Nothing was lost: your dashboard shows exactly where this stopped and you can resume from there.',
      )
      setStep('form')
    }
  }

  const preview = quotePenalty(bucket.balance)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog" aria-modal="true" aria-labelledby="lock-bucket-title">
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => { if (!busy) onClose() }} />

      <div className="relative w-full max-w-md rounded-2xl bg-[var(--split-bg-primary)] p-6 shadow-2xl">
        {step === 'done' ? (
          <div className="text-center">
            <p className="text-lg font-semibold text-[var(--split-text-primary)]">Locked</p>
            <p className="mt-1 text-sm text-[var(--split-text-secondary)]">
              {bucket.name} now routes into your lock
              {swept > 0n ? `, and ${formatUsdc(swept)} USDC moved in` : ''}.
            </p>
            <button type="button" onClick={onClose}
              className="mt-4 w-full rounded-xl bg-[#111110] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85">
              Done
            </button>
          </div>
        ) : resumeLock ? (
          <div className="space-y-3">
            <h2 id="lock-bucket-title" className="text-base font-semibold text-[var(--split-text-primary)]">
              Finish locking {bucket.name}
            </h2>
            <p className="text-xs leading-relaxed text-[var(--split-text-secondary)]">
              This bucket already routes new deposits into its lock, but{' '}
              <strong className="text-[var(--split-text-primary)]">{formatUsdc(bucket.balance)} USDC</strong>{' '}
              is still held in Split from before. That money is{' '}
              <strong className="text-[var(--split-text-primary)]">not locked yet</strong> and you can
              still withdraw it normally. Moving it in finishes the job.
            </p>
            {busy && (
              <p role="status" aria-live="polite" className="text-xs text-[var(--split-text-secondary)]">
                Moving your balance in…
              </p>
            )}
            {error && <p role="alert" className="text-xs leading-relaxed text-red-400">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} disabled={busy}
                className="flex-1 rounded-xl border border-[var(--split-border)] px-4 py-2.5 text-sm font-medium text-[var(--split-text-secondary)] transition hover:text-[var(--split-text-primary)] disabled:opacity-40">
                Not now
              </button>
              <button type="button" onClick={() => void handleResume()} disabled={busy}
                className="flex-1 rounded-xl bg-[#111110] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40">
                {busy ? 'Moving…' : 'Move it in'}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleLock} noValidate className="space-y-3">
            <h2 id="lock-bucket-title" className="text-base font-semibold text-[var(--split-text-primary)]">
              Lock {bucket.name}
            </h2>

            {scheduleActive && (
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-3">
                <p className="text-[11px] leading-relaxed text-amber-300">
                  This bucket has an active scheduled send. It has to be cancelled first,
                  otherwise the scheduler could move this bucket&rsquo;s balance to its old
                  destination part-way through locking. Cancelling is permanent: the
                  schedule is not restored afterwards, and you would set it up again yourself.
                </p>
                <button type="button" onClick={() => void handleCancelSchedule()} disabled={busy}
                  className="mt-2 w-full rounded-lg border border-amber-400/40 px-3 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/10 disabled:opacity-40">
                  {step === 'cancelSchedule' ? 'Cancelling…' : 'Cancel the scheduled send'}
                </button>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="lb-date">
                Unlock date <span className="text-[var(--split-text-tertiary)]">(required)</span>
              </label>
              <input id="lb-date" type="date" value={dateStr} disabled={busy}
                onChange={(e) => { setDateStr(e.target.value); setError(null) }}
                className="w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)]" />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="lb-target">
                Target amount <span className="text-[var(--split-text-tertiary)]">(optional, unlocks earlier)</span>
              </label>
              <input id="lb-target" type="number" min="0" step="0.000001" inputMode="decimal"
                placeholder="e.g. 500" value={targetStr} disabled={busy}
                onChange={(e) => { setTargetStr(e.target.value); setError(null) }}
                className="w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 font-mono text-sm text-[var(--split-text-primary)] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)]" />
              {targetStr.trim() !== '' && (
                <p className="text-[11px] leading-relaxed text-[var(--split-text-tertiary)]">
                  Any USDC sent to this lock, including funds sent by another person,
                  counts toward the target and can unlock it early.
                </p>
              )}
            </div>

            {/* All four facts, stated before the first transaction. */}
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] p-3">
              <input type="checkbox" checked={confirmed} disabled={busy}
                onChange={(e) => { setConfirmed(e.target.checked); setError(null) }} className="mt-0.5" />
              <span className="text-[11px] leading-relaxed text-[var(--split-text-secondary)]">
                {bucket.balance > 0n ? (
                  <>Your {formatUsdc(bucket.balance)} USDC in this bucket will be moved into the lock, and </>
                ) : (
                  <>Future deposits to this bucket will go into the lock, and </>
                )}
                withdrawing before it unlocks costs 10%
                {bucket.balance > 0n ? <> (taking out all {formatUsdc(bucket.balance)} early would return {formatUsdc(preview.net)} USDC)</> : null}.
                Turning the lock off later does not release money already inside it.
                This takes {scheduleActive ? 'four' : bucket.balance > 0n ? 'three' : 'two'} separate transactions and can be resumed if you stop part-way.
              </span>
            </label>

            {busy && (
              <p role="status" aria-live="polite" className="text-xs text-[var(--split-text-secondary)]">
                {step === 'creating'  && 'Creating your lock…'}
                {step === 'routing'   && 'Pointing this bucket at the lock…'}
                {step === 'sweeping'  && 'Moving your existing balance in…'}
                {step === 'cancelSchedule' && 'Cancelling the scheduled send…'}
              </p>
            )}

            {error && <p role="alert" className="text-xs leading-relaxed text-red-400">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} disabled={busy}
                className="flex-1 rounded-xl border border-[var(--split-border)] px-4 py-2.5 text-sm font-medium text-[var(--split-text-secondary)] transition hover:text-[var(--split-text-primary)] disabled:opacity-40">
                Cancel
              </button>
              <button type="submit" disabled={busy || !!scheduleActive || !confirmed || !dateStr}
                className="flex-1 rounded-xl bg-[#111110] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40">
                {busy ? 'Working…' : 'Lock this bucket'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
