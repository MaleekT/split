'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { parseUnits, isAddress } from 'viem'
import { useAccount, useReadContracts, useWriteContract } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { getSplitContract, splitAbi, erc20Abi, USDC, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { buildDepositForMemo } from '@/lib/memos'
import { publicClient } from '@/lib/arc'
import { parseSplitError } from '@/lib/errors'
import { shortAddress, formatUsdc } from '@/lib/format'

const TX_TIMEOUT_MS = 30_000

interface Props {
  recipientAddress: `0x${string}`
  displayName:      string
}

function safeFormatUsdc(val: bigint): string {
  try { return formatUsdc(val) }
  catch { return '?' }
}

// Strip non-printable ASCII and limit length — prevents control chars leaking into UI
function sanitizeDisplayName(raw: string, fallback: string): string {
  const clean = raw.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 60)
  return clean.length > 0 ? clean : fallback
}

export function PayForm({ recipientAddress, displayName }: Props) {
  // CRITICAL fix: validate recipientAddress at component boundary
  if (!isAddress(recipientAddress)) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <p className="text-sm text-[var(--split-text-danger)]">Invalid recipient address.</p>
      </div>
    )
  }

  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const contractAddress = getSplitContract()
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // CRITICAL fix: sanitize displayName at component boundary
  const safeDisplayName = sanitizeDisplayName(displayName, shortAddress(recipientAddress))

  // Batch: recipient bucket count + visitor allowance + visitor USDC balance
  const { data } = useReadContracts({
    contracts: [
      {
        address:      contractAddress,
        abi:          splitAbi,
        functionName: 'getBuckets',
        args:         [recipientAddress],
      },
      {
        address:      USDC,
        abi:          erc20Abi,
        functionName: 'allowance',
        args:         [address ?? ZERO_ADDRESS, contractAddress],
      },
      {
        address:      USDC,
        abi:          erc20Abi,
        functionName: 'balanceOf',
        args:         [address ?? ZERO_ADDRESS],
      },
    ],
    query: { refetchInterval: 30_000 },
  })

  const recipientBuckets = (data?.[0]?.result ?? []) as SplitBucket[]
  const allowance        = (data?.[1]?.result ?? 0n) as bigint
  const walletBal        = (data?.[2]?.result ?? 0n) as bigint
  const hasNoBuckets     = recipientBuckets.length === 0

  const [amountStr, setAmountStr]       = useState('')
  const [noteStr, setNoteStr]           = useState('')
  const [step, setStep]                 = useState<'idle' | 'approving' | 'sending'>('idle')
  const [error, setError]               = useState<string | null>(null)
  const [sentTxHash, setSentTxHash]     = useState<string | null>(null)
  const [sentAmount, setSentAmount]     = useState<bigint | null>(null)

  // Parse once per render — null means empty or invalid input
  const parsedAmount = useMemo<bigint | null>(() => {
    if (!amountStr.trim()) return null
    try { return parseUnits(amountStr.trim(), 6) }
    catch { return null }
  }, [amountStr])

  const needsApproval = parsedAmount !== null && allowance < parsedAmount

  const btnLabel =
    step === 'approving' ? 'Approving USDC…'
    : step === 'sending' ? 'Sending…'
    : needsApproval      ? 'Approve & send'
    : 'Send USDC'

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Capture at call-time — prevents stale closure between approve and send steps
    const amount           = parsedAmount
    // HIGH fix: capture allowance at call-time to avoid race condition with refetch
    const currentAllowance = allowance

    if (!amount || amount === 0n) { setError('Enter a valid USDC amount.'); return }
    if (amount > walletBal)       { setError(`Insufficient balance — you have ${safeFormatUsdc(walletBal)} USDC.`); return }

    try {
      // ── Step 1: approve if needed ──
      if (currentAllowance < amount) {
        setStep('approving')
        const approveTx = await writeContractAsync({
          address:      USDC,
          abi:          erc20Abi,
          functionName: 'approve',
          args:         [contractAddress, amount],
        })
        await publicClient.waitForTransactionReceipt({
          hash:            approveTx,
          pollingInterval: 500,
          timeout:         TX_TIMEOUT_MS,
        })
        // HIGH fix: check mounted after each await so we don't continue on unmounted component
        if (!mounted.current) return
      }

      // ── Step 2: depositFor (wrapped in Memo if note provided) ──
      setStep('sending')
      const memoArgs = buildDepositForMemo(recipientAddress, amount, noteStr)
      const sendTx = await writeContractAsync(
        memoArgs ?? {
          address:      contractAddress,
          abi:          splitAbi,
          functionName: 'depositFor',
          args:         [recipientAddress, amount],
        }
      )
      await publicClient.waitForTransactionReceipt({
        hash:            sendTx,
        pollingInterval: 500,
        timeout:         TX_TIMEOUT_MS,
      })

      if (mounted.current) {
        setSentTxHash(sendTx)
        setSentAmount(amount)
        setAmountStr('')
        setNoteStr('')
      }
    } catch (err) {
      let message = 'Something went wrong. Please try again.'
      try { message = parseSplitError(err) } catch { /* parseSplitError is safe; guard is defensive */ }
      if (mounted.current) setError(message)
    } finally {
      if (mounted.current) setStep('idle')
    }
  }

  // ── Success state ──
  if (sentTxHash && sentAmount !== null) {
    // HIGH fix: bounds-safe slice — tx hashes are 66 chars but guard defensively
    const txPreview = sentTxHash.length > 10 ? `${sentTxHash.slice(0, 10)}…` : sentTxHash

    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--split-bg-tertiary)]">
        <div className="w-full max-w-sm rounded-2xl bg-[var(--split-bg-primary)] border border-[var(--split-border)] p-8 text-center space-y-5">
          <div
            className="w-14 h-14 rounded-full bg-[var(--split-accent-light)] flex items-center justify-center mx-auto"
            aria-hidden="true"
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--split-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>

          <div>
            <p className="text-lg font-semibold text-[var(--split-text-primary)]">Sent!</p>
            <p className="text-sm text-[var(--split-text-secondary)] mt-1">
              <span className="font-mono font-semibold text-[var(--split-text-primary)]">
                {safeFormatUsdc(sentAmount)} USDC
              </span>
              {' '}sent to {safeDisplayName}
            </p>
          </div>

          <a
            href={`https://testnet.arcscan.app/tx/${sentTxHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs font-mono text-[var(--split-text-tertiary)] hover:text-[var(--split-accent)] underline underline-offset-2 transition-colors"
          >
            {txPreview} · view on explorer
          </a>

          <button
            type="button"
            onClick={() => { setSentTxHash(null); setSentAmount(null) }}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-[var(--split-accent)] bg-[var(--split-accent-light)] hover:opacity-85 transition-opacity"
          >
            Send again
          </button>
        </div>
      </div>
    )
  }

  // ── Pay form ──
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[var(--split-bg-tertiary)]">
      <div className="w-full max-w-sm space-y-5">

        {/* Recipient badge */}
        <div className="text-center space-y-2">
          <div
            aria-hidden="true"
            className="w-14 h-14 rounded-full bg-[var(--split-accent-light)] flex items-center justify-center mx-auto text-xl font-bold text-[var(--split-accent)] select-none"
          >
            {safeDisplayName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[var(--split-text-primary)]">
              Pay {safeDisplayName}
            </h1>
            <p className="text-xs font-mono text-[var(--split-text-tertiary)] mt-0.5">
              {shortAddress(recipientAddress)}
            </p>
          </div>
        </div>

        {/* Pay card */}
        <div className="rounded-2xl bg-[var(--split-bg-primary)] border border-[var(--split-border)] p-6 space-y-5">
          {hasNoBuckets && (
            <div
              role="alert"
              className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800"
            >
              This recipient hasn&apos;t set up their payment rules yet and cannot receive funds.
            </div>
          )}

          <form onSubmit={handleSend} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <label
                htmlFor="pay-amount"
                className="text-xs font-medium text-[var(--split-text-secondary)]"
              >
                Amount
              </label>
              <div className="relative">
                <input
                  id="pay-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.000001"
                  step="0.000001"
                  placeholder="0.00"
                  required
                  autoFocus
                  value={amountStr}
                  onChange={(e) => setAmountStr(e.target.value)}
                  className="w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-3 pr-16 text-base font-mono text-[var(--split-text-primary)] placeholder:text-[var(--split-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)] focus:border-transparent transition"
                />
                <span
                  aria-hidden="true"
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-[var(--split-text-tertiary)] font-mono select-none"
                >
                  USDC
                </span>
              </div>
              {address && walletBal > 0n && (
                <p className="text-xs text-[var(--split-text-tertiary)]">
                  Balance:{' '}
                  <button
                    type="button"
                    onClick={() => setAmountStr(safeFormatUsdc(walletBal))}
                    className="font-mono tabular-nums text-[var(--split-accent)] hover:opacity-80 transition-opacity"
                  >
                    {safeFormatUsdc(walletBal)} USDC
                  </button>
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="pay-note"
                className="text-xs font-medium text-[var(--split-text-secondary)]"
              >
                Note <span className="font-normal text-[var(--split-text-tertiary)]">(Optional)</span>
              </label>
              <input
                id="pay-note"
                type="text"
                placeholder="Invoice #001, project name, or any reference"
                value={noteStr}
                onChange={(e) => setNoteStr(e.target.value)}
                className="w-full rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] px-3.5 py-3 text-sm text-[var(--split-text-primary)] placeholder:text-[var(--split-text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--split-accent)] focus:border-transparent transition"
              />
            </div>

            {error && (
              <p className="text-sm text-[var(--split-text-danger)]" role="alert">{error}</p>
            )}

            {!address ? (
              <div className="flex justify-center pt-1">
                <ConnectButton label="Connect wallet to send" />
              </div>
            ) : (
              <button
                type="submit"
                disabled={step !== 'idle' || !parsedAmount || hasNoBuckets}
                className="w-full px-4 py-3 rounded-xl text-sm font-semibold text-white bg-[var(--split-accent)] hover:opacity-85 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {btnLabel}
              </button>
            )}
          </form>
        </div>

        <p className="text-center text-xs text-[var(--split-text-tertiary)]">
          Powered by{' '}
          <a href="/" className="hover:text-[var(--split-accent)] transition-colors underline underline-offset-2">
            Split
          </a>
        </p>
      </div>
    </div>
  )
}
