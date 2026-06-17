'use client'

import { useState, useEffect, useRef } from 'react'
import { parseUnits } from 'viem'
import { useAccount } from 'wagmi'
import { formatUsdc } from '@/lib/format'
import type { SplitBucket } from '@/lib/contracts'

interface Props {
  bucket:      SplitBucket
  currentGoal: bigint | undefined
  onClose:     () => void
  onSaved:     (bucketId: string, newGoal: bigint) => void
}

const inputCls =
  'w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] placeholder:text-[var(--split-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)] focus:border-transparent transition'

export function GoalModal({ bucket, currentGoal, onClose, onSaved }: Props) {
  const { address } = useAccount()
  const modalRef   = useRef<HTMLDivElement>(null)
  const mounted    = useRef(true)
  // Ref keeps onClose current without causing effect re-registration
  const onCloseRef = useRef(onClose)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => { onCloseRef.current = onClose })

  const [amountStr, setAmountStr] = useState(
    currentGoal && currentGoal > 0n ? formatUsdc(currentGoal) : '',
  )
  const [pending, setPending] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  // Escape + focus trap — single stable registration, no re-attaches on render
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab' || !modalRef.current) return
      const els = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled])',
        ),
      )
      if (els.length === 0) return
      const first = els[0]!
      const last  = els[els.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        last.focus(); e.preventDefault()
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus(); e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, []) // stable — onCloseRef handles prop updates without re-registration

  // Accept bigint directly — eliminates unsafe string→BigInt conversion at call site
  async function call(targetAmount: bigint) {
    if (!address) return
    setPending(true)
    setError(null)
    try {
      const r = await fetch('/api/goals', {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-Requested-With': 'XMLHttpRequest', // CSRF: custom headers trigger CORS preflight for cross-origin requests
        },
        body: JSON.stringify({
          address,
          bucket_id:     String(bucket.id),
          target_amount: String(targetAmount),
        }),
      })
      const body = await r.json() as { error?: string }
      if (!r.ok) throw new Error(body.error ?? 'Failed to save goal')
      if (mounted.current) {
        onSaved(String(bucket.id), targetAmount)
        onClose()
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Failed to save goal')
    } finally {
      if (mounted.current) setPending(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    let raw: bigint
    try {
      raw = parseUnits(amountStr.trim(), 6)
    } catch {
      setError('Enter a valid amount, e.g. 100 or 250.50.')
      return
    }
    if (raw === 0n) { setError('Goal must be greater than zero.'); return }
    await call(raw)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="goal-title"
    >
      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />

      <div ref={modalRef} className="relative w-full max-w-sm rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl p-6 space-y-5">
        <div>
          <h2 id="goal-title" className="text-base font-semibold text-[var(--split-text-primary)]">
            {currentGoal ? 'Update goal' : 'Set savings goal'} — {bucket.name}
          </h2>
          <p className="text-sm text-[var(--split-text-secondary)] mt-0.5">
            Track progress toward a target USDC balance.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="goal-amount">
              Target amount (USDC)
            </label>
            <div className="relative">
              <input
                id="goal-amount"
                type="number"
                required
                min="0.000001"
                step="0.000001"
                placeholder="0.00"
                autoFocus
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                className={`${inputCls} font-mono pr-16`}
              />
              <span
                aria-hidden="true"
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-[var(--split-text-tertiary)] font-mono select-none"
              >
                USDC
              </span>
            </div>
          </div>

          {error && <p className="text-sm text-[var(--split-text-danger)]" role="alert">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium border border-[var(--split-border)] text-[var(--split-text-secondary)] hover:bg-[var(--split-bg-secondary)] transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !amountStr.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-[var(--split-accent)] hover:opacity-85 transition-opacity disabled:opacity-40"
            >
              {pending ? 'Saving…' : currentGoal ? 'Update goal' : 'Set goal'}
            </button>
          </div>

          {currentGoal && currentGoal > 0n && (
            <button
              type="button"
              onClick={() => void call(0n)}
              disabled={pending}
              className="w-full text-xs text-[var(--split-text-tertiary)] hover:text-[var(--split-text-danger)] transition-colors disabled:opacity-40"
            >
              Clear goal
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
