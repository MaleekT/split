'use client'

import { useState, useEffect, useCallback } from 'react'
import { parseUnits } from 'viem'
import { useWriteContract } from 'wagmi'
import { formatUsdc, shortAddress } from '@/lib/format'
import { publicClient } from '@/lib/arc'
import { bucketLockAbi } from '@/lib/lock-contracts'
import { type LockState } from '@/lib/lock'

// Withdrawing from a BucketLock. Deliberately NOT part of withdraw-modal: a lock
// is its own contract and this never touches Split, exactly as
// bucket-wallet-send-modal sits beside the withdraw path rather than inside it.
//
// The arithmetic shown here comes from the CONTRACT's own previewWithdraw, read
// immediately before signing, so the screen cannot disagree with the transaction.
// previewWithdraw is current-block truth; the mined transaction is authoritative
// above it, and a stale preview surfaces as a retryable error rather than a
// failure.

const TX_TIMEOUT_MS = 30_000

interface Props {
  bucketName: string
  lockAddress: `0x${string}`
  state: LockState
  unlockedNow: boolean
  onClose: () => void
  onWithdrawn: () => void
}

interface Preview {
  net:     bigint
  penalty: bigint
  early:   boolean
}

export function LockWithdrawModal({
  bucketName, lockAddress, state, unlockedNow, onClose, onWithdrawn,
}: Props) {
  const { writeContractAsync } = useWriteContract()

  const [amountStr, setAmountStr] = useState('')
  const [preview, setPreview]     = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pending, setPending]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [sentTx, setSentTx]       = useState<`0x${string}` | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pending) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, pending])

  const parsed = (): bigint | null => {
    const t = amountStr.trim()
    if (!t) return null
    try { const v = parseUnits(t, 6); return v > 0n ? v : null } catch { return null }
  }

  /**
   * Quote from the chain, not from a local mirror. Any revert is reported in the
   * words the contract would use and disables submission, so the user never
   * reaches a wallet prompt for a transaction that cannot succeed.
   */
  const refreshPreview = useCallback(async (amount: bigint): Promise<Preview | null> => {
    setPreviewError(null)
    try {
      const [net, penalty, early] = await publicClient.readContract({
        address: lockAddress, abi: bucketLockAbi,
        functionName: 'previewWithdraw', args: [amount],
      }) as readonly [bigint, bigint, boolean]
      const next = { net, penalty, early }
      setPreview(next)
      return next
    } catch (e) {
      setPreview(null)
      const msg = e instanceof Error ? e.message : String(e)
      setPreviewError(
        /PenaltyExceedsAmount/.test(msg)
          ? 'That amount is too small to withdraw early: the 10% fee would take all of it. Withdraw at least 0.000002 USDC.'
          : /InsufficientBalance/.test(msg)
            ? 'That is more than this lock holds.'
            : /InvalidAmount/.test(msg)
              ? 'Enter an amount greater than zero.'
              : 'Could not read the current figures. Check your connection and try again.',
      )
      return null
    }
  }, [lockAddress])

  useEffect(() => {
    const amount = parsed()
    if (amount === null) { setPreview(null); setPreviewError(null); return }
    const id = setTimeout(() => { void refreshPreview(amount) }, 250)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountStr, refreshPreview])

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const amount = parsed()
    if (amount === null) { setError('Enter an amount greater than zero.'); return }
    if (previewError)    { setError(previewError); return }
    if (preview?.early && !confirmed) {
      setError('Confirm that you understand the 10% early-withdrawal fee.')
      return
    }

    setPending(true)
    try {
      // Re-read immediately before signing, and ACT on the result. The lock may
      // have unlocked, or its balance may have moved, since the figures above
      // were fetched. Re-reading without gating on the answer would defeat the
      // entire purpose of re-reading.
      const fresh = await refreshPreview(amount)
      if (fresh === null) {
        setError('The figures changed while you were confirming. Nothing was withdrawn. Check the amounts above and try again.')
        setPending(false)
        return
      }
      // An amount that was penalty-free a moment ago can become an early break,
      // or vice versa. Never sign a transaction whose cost the user has not seen.
      if (fresh.early && !preview?.early) {
        setError('This lock is no longer unlocked, so a 10% fee now applies. Review the updated figures and confirm again.')
        setConfirmed(false)
        setPending(false)
        return
      }
      if (fresh.penalty !== preview?.penalty || fresh.net !== preview?.net) {
        setError('The figures changed while you were confirming. Nothing was withdrawn. Review the updated amounts and try again.')
        setConfirmed(false)
        setPending(false)
        return
      }

      const hash = await writeContractAsync({
        address: lockAddress, abi: bucketLockAbi,
        functionName: 'withdraw', args: [amount],
      })
      await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
      setSentTx(hash)
      onWithdrawn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        /User rejected|denied/i.test(msg)
          ? 'Cancelled in your wallet.'
          : 'The withdrawal did not go through. Nothing was taken from your lock. You can try again.',
      )
    } finally {
      setPending(false)
    }
  }

  const amount = parsed()
  const canSubmit =
    !pending && amount !== null && preview !== null && previewError === null &&
    (!preview.early || confirmed)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog" aria-modal="true" aria-labelledby="lock-withdraw-title"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => { if (!pending) onClose() }} />

      <div className="relative w-full max-w-md rounded-2xl bg-[var(--split-bg-primary)] p-6 shadow-2xl">
        {sentTx ? (
          <div className="text-center">
            <p className="text-lg font-semibold text-[var(--split-text-primary)]">Withdrawn</p>
            <p className="mt-1 text-sm text-[var(--split-text-secondary)]">
              {formatUsdc(preview?.net ?? 0n)} USDC from {bucketName}
              {preview?.early ? ` · ${formatUsdc(preview.penalty)} USDC fee` : ''}
            </p>
            <a
              href={`https://testnet.arcscan.app/tx/${sentTx}`}
              target="_blank" rel="noopener noreferrer"
              className="mt-3 inline-block font-mono text-xs text-[var(--split-text-tertiary)] underline"
            >
              {sentTx.slice(0, 10)}… · view on explorer
            </a>
            <button
              type="button" onClick={onClose}
              className="mt-4 w-full rounded-xl bg-[#111110] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleWithdraw} noValidate className="space-y-3">
            <div>
              <h2 id="lock-withdraw-title" className="text-base font-semibold text-[var(--split-text-primary)]">
                Withdraw from {bucketName}
              </h2>
              <p className="mt-0.5 font-mono text-xs text-[var(--split-text-tertiary)]">
                {shortAddress(lockAddress)} · {formatUsdc(state.balance)} USDC held
              </p>
            </div>

            {!unlockedNow && (
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-3">
                <p className="text-[11px] leading-relaxed text-amber-300">
                  This bucket is still locked. You can withdraw now, but it costs{' '}
                  <strong>10%</strong> of whatever you take out.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="lock-amount">Amount</label>
              <input
                id="lock-amount" type="number" inputMode="decimal" min="0.000001" step="0.000001"
                placeholder="0.00" value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                className="w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)]"
              />
              <button
                type="button"
                onClick={() => setAmountStr(formatUsdc(state.balance).replace(/,/g, ''))}
                className="text-xs text-[var(--split-text-tertiary)] underline transition-colors hover:text-[var(--split-text-primary)]"
              >
                Withdraw everything
              </button>
            </div>

            {/* The contract's own arithmetic, not a local guess. */}
            {preview && (
              <dl className="space-y-1 rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] p-3 text-xs">
                <div className="flex justify-between">
                  <dt className="text-[var(--split-text-secondary)]">You take out</dt>
                  <dd className="font-mono text-[var(--split-text-primary)]">{formatUsdc(amount ?? 0n)} USDC</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-[var(--split-text-secondary)]">Early-withdrawal fee</dt>
                  <dd className="font-mono text-[var(--split-text-primary)]">
                    {preview.early ? `−${formatUsdc(preview.penalty)} USDC` : 'None'}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-[var(--split-border)] pt-1">
                  <dt className="font-medium text-[var(--split-text-primary)]">You receive</dt>
                  <dd className="font-mono font-semibold text-[var(--split-text-primary)]">{formatUsdc(preview.net)} USDC</dd>
                </div>
              </dl>
            )}

            {previewError && (
              <p role="alert" className="text-xs leading-relaxed text-amber-300">{previewError}</p>
            )}

            {preview?.early && (
              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] p-3">
                <input
                  type="checkbox" checked={confirmed}
                  onChange={(e) => { setConfirmed(e.target.checked); setError(null) }}
                  className="mt-0.5"
                />
                <span className="text-[11px] leading-relaxed text-[var(--split-text-secondary)]">
                  I understand {formatUsdc(preview.penalty)} USDC will be kept as an
                  early-withdrawal fee, and that I will receive {formatUsdc(preview.net)} USDC.
                </span>
              </label>
            )}

            {error && <p role="alert" className="text-xs leading-relaxed text-red-400">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button
                type="button" onClick={onClose} disabled={pending}
                className="flex-1 rounded-xl border border-[var(--split-border)] px-4 py-2.5 text-sm font-medium text-[var(--split-text-secondary)] transition hover:text-[var(--split-text-primary)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit" disabled={!canSubmit}
                className="flex-1 rounded-xl bg-[#111110] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? 'Withdrawing…' : 'Withdraw'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
