'use client'

import { useState, useEffect } from 'react'
import { isAddress, parseUnits, formatUnits } from 'viem'
import { formatUsdc, shortAddress } from '@/lib/format'
import { useBucketWallets } from '@/hooks/use-bucket-wallets'

// Sending from a generated bucket wallet. Deliberately NOT part of withdraw-modal:
// a generated wallet is a plain EOA, so this is a direct USDC transfer that never
// touches the Split contract. Different plumbing, kept in its own component so the
// live withdraw path stays untouched.

interface Props {
  bucketName:      string
  derivationIndex: number
  /** The bucket's destination as read from the CHAIN, not from the metadata hint. */
  walletAddress:   `0x${string}`
  onClose:         () => void
  onSent:          () => void
}

export function BucketWalletSendModal({
  bucketName, derivationIndex, walletAddress, onClose, onSent,
}: Props) {
  const bucketWallets = useBucketWallets()

  const [sendable, setSendable] = useState<bigint | null>(null)
  const [toStr, setToStr]       = useState('')
  const [amountStr, setAmount]  = useState('')
  const [pending, setPending]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [sentTx, setSentTx]     = useState<`0x${string}` | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Spendable balance, already net of the gas this send will consume. Null means
  // "not read yet", which is kept distinct from zero: showing 0 for an unknown
  // balance would tell the user funds are unspendable when they are not.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const b = await bucketWallets.spendableBalance(walletAddress)
        if (alive) setSendable(b)
      } catch {
        if (alive) setError('Could not read this wallet’s balance. Try again.')
      }
    })()
    return () => { alive = false }
  }, [bucketWallets, walletAddress])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const to = toStr.trim()
    if (!isAddress(to)) { setError('Enter a valid destination address.'); return }

    let amountRaw: bigint
    try {
      amountRaw = parseUnits(amountStr.trim(), 6)
      if (amountRaw <= 0n) throw new Error()
    } catch { setError('Enter an amount greater than zero.'); return }

    setPending(true)
    try {
      const tx = await bucketWallets.sendFrom({
        derivationIndex,
        expectedDestination: walletAddress,
        to: to as `0x${string}`,
        amountRaw,
      })
      setSentTx(tx)
      onSent()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog" aria-modal="true" aria-label={`Send from ${bucketName}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-[var(--split-border)] bg-[var(--split-bg)] p-5">
        {sentTx ? (
          <div className="text-center">
            <p className="text-lg font-semibold text-[var(--split-text-primary)]">Sent</p>
            <p className="mt-1 text-sm text-[var(--split-text-secondary)]">
              {formatUsdc(parseUnits(amountStr.trim() || '0', 6))} USDC from {bucketName}
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
          <form onSubmit={handleSend} noValidate className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-[var(--split-text-primary)]">Send from {bucketName}</h2>
              <p className="mt-0.5 font-mono text-xs text-[var(--split-text-tertiary)]">
                {shortAddress(walletAddress)}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="bw-to">To</label>
              <input
                id="bw-to" type="text" placeholder="0x…" value={toStr}
                onChange={(e) => setToStr(e.target.value)}
                className="w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 font-mono text-sm text-[var(--split-text-primary)] transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--split-text-secondary)]" htmlFor="bw-amount">Amount</label>
              <input
                id="bw-amount" type="number" inputMode="decimal" min="0.000001" step="0.000001"
                placeholder="0.00" value={amountStr}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-2.5 text-sm text-[var(--split-text-primary)] transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)]"
              />
              <div className="flex items-center gap-1.5 text-xs text-[var(--split-text-tertiary)]">
                <span>Available:</span>
                {sendable === null ? (
                  <span>checking…</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAmount(formatUnits(sendable, 6))}
                    className="font-mono font-semibold text-[var(--split-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--split-accent)]"
                  >
                    {formatUsdc(sendable)} USDC
                  </button>
                )}
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--split-text-tertiary)]">
                On Arc the gas comes out of this wallet&apos;s own USDC, so the available
                amount is already net of the fee.
              </p>
            </div>

            {error && <p role="alert" className="text-xs leading-relaxed text-red-400">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button
                type="button" onClick={onClose}
                className="flex-1 rounded-xl border border-[var(--split-border)] px-4 py-2.5 text-sm font-medium text-[var(--split-text-secondary)] transition hover:border-[var(--split-text-tertiary)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending || sendable === null || sendable === 0n || !isAddress(toStr.trim()) || !amountStr.trim()}
                className="flex-1 rounded-xl bg-[#111110] px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-85 disabled:opacity-40"
              >
                {pending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
