'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { parseUnits, isAddress, formatUnits } from 'viem'
import { useAccount, useReadContracts, useWriteContract } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { getSplitContract, splitAbi, erc20Abi, USDC, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { buildDepositForMemo } from '@/lib/memos'
import { publicClient } from '@/lib/arc'
import { parseSplitError } from '@/lib/errors'
import { shortAddress, formatUsdc } from '@/lib/format'

const TX_TIMEOUT_MS = 30_000
const ACCENT       = '#16C784'
const ACCENT_GLOW  = 'rgba(22,199,132,0.25)'

interface Props {
  recipientAddress: `0x${string}`
  displayName:      string
}

function safeFormatUsdc(val: bigint): string {
  try { return formatUsdc(val) } catch { return '?' }
}

function sanitizeDisplayName(raw: string, fallback: string): string {
  const clean = raw.replace(/[^\x20-\x7E]/g, '').trim().slice(0, 60)
  return clean.length > 0 ? clean : fallback
}

// ── Icons ──────────────────────────────────────────────────────────────────────

function IconSend() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  )
}
function IconDollar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  )
}
function IconChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  )
}
function IconWallet() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/>
      <path d="M16 3H8L4 7h16l-4-4z"/>
      <circle cx="17" cy="13" r="1" fill="rgba(255,255,255,0.35)" stroke="none"/>
    </svg>
  )
}
function IconDoc() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  )
}
function IconCopy({ active }: { active: boolean }) {
  return active ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  )
}
function IconShield() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  )
}
function IconLightning() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  )
}
function IconCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  )
}
function IconSpinner() {
  // animate-spin is a Tailwind utility — keyframes come from Tailwind, no inline <style> needed
  return (
    <svg className="animate-spin" style={{ transformOrigin: 'center' }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25"/>
      <path d="M12 2a10 10 0 0 1 10 10"/>
    </svg>
  )
}

const TRUST_ITEMS = [
  { Icon: IconShield,    title: 'Secure',   sub: 'Protected transfer' },
  { Icon: IconLightning, title: 'Fast',     sub: 'Usually instant'    },
  { Icon: IconCheck,     title: 'Reliable', sub: 'USDC on Arc'        },
]

// ── Component ──────────────────────────────────────────────────────────────────

export function PayForm({ recipientAddress, displayName }: Props) {
  if (!isAddress(recipientAddress)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#07090F' }}>
        <p style={{ fontSize: 14, color: '#FF6B6B' }}>Invalid recipient address.</p>
      </div>
    )
  }

  const { address }            = useAccount()
  const { writeContractAsync } = useWriteContract()
  const contractAddress        = getSplitContract()
  const mounted                = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const safeDisplayName = sanitizeDisplayName(displayName, shortAddress(recipientAddress))

  const { data } = useReadContracts({
    contracts: [
      { address: contractAddress, abi: splitAbi,  functionName: 'getBuckets',  args: [recipientAddress] },
      { address: USDC,            abi: erc20Abi,  functionName: 'allowance',   args: [address ?? ZERO_ADDRESS, contractAddress] },
      { address: USDC,            abi: erc20Abi,  functionName: 'balanceOf',   args: [address ?? ZERO_ADDRESS] },
    ],
    query: { refetchInterval: 30_000 },
  })

  const recipientBuckets = (data?.[0]?.result ?? []) as SplitBucket[]
  const allowance        = (data?.[1]?.result ?? 0n) as bigint
  const walletBal        = (data?.[2]?.result ?? 0n) as bigint
  const hasNoBuckets     = recipientBuckets.length === 0

  const [amountStr,  setAmountStr]  = useState('')
  const [noteStr,    setNoteStr]    = useState('')
  const [step,       setStep]       = useState<'idle' | 'approving' | 'sending'>('idle')
  const [error,      setError]      = useState<string | null>(null)
  const [sentTxHash, setSentTxHash] = useState<string | null>(null)
  const [sentAmount, setSentAmount] = useState<bigint | null>(null)
  const [copied,     setCopied]     = useState(false)

  const parsedAmount = useMemo<bigint | null>(() => {
    if (!amountStr.trim()) return null
    try { return parseUnits(amountStr.trim(), 6) } catch { return null }
  }, [amountStr])

  const needsApproval = parsedAmount !== null && allowance < parsedAmount
  const isDisabled    = step !== 'idle' || !parsedAmount || hasNoBuckets

  const btnLabel =
    step === 'approving' ? 'Approving…'
    : step === 'sending'  ? 'Sending…'
    : needsApproval       ? 'Approve & Send'
    : 'Send USDC'

  function handleCopy() {
    // Guard: clipboard API requires secure context (HTTPS) and a modern browser
    if (!navigator?.clipboard?.writeText) return
    navigator.clipboard.writeText(recipientAddress)
      .then(() => { setCopied(true); setTimeout(() => { if (mounted.current) setCopied(false) }, 1500) })
      .catch(() => { /* copy failed silently — button stays in default state */ })
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const amount           = parsedAmount
    const currentAllowance = allowance
    if (!amount || amount === 0n) { setError('Enter a valid USDC amount.'); return }
    if (amount > walletBal)       { setError(`Insufficient balance — you have ${safeFormatUsdc(walletBal)} USDC.`); return }

    try {
      if (currentAllowance < amount) {
        setStep('approving')
        const approveTx = await writeContractAsync({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [contractAddress, amount] })
        await publicClient.waitForTransactionReceipt({ hash: approveTx, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
        if (!mounted.current) return
      }

      setStep('sending')
      const memoArgs = buildDepositForMemo(recipientAddress, amount, noteStr)
      const sendTx   = memoArgs
        ? await writeContractAsync(memoArgs)
        : await writeContractAsync({ address: contractAddress, abi: splitAbi, functionName: 'depositFor', args: [recipientAddress, amount] })
      await publicClient.waitForTransactionReceipt({ hash: sendTx, pollingInterval: 500, timeout: TX_TIMEOUT_MS })

      if (mounted.current) { setSentTxHash(sendTx); setSentAmount(amount); setAmountStr(''); setNoteStr('') }
    } catch (err) {
      let message = 'Something went wrong. Please try again.'
      try { message = parseSplitError(err) } catch {}
      if (mounted.current) setError(message)
    } finally {
      if (mounted.current) setStep('idle')
    }
  }

  // ── Success ────────────────────────────────────────────────────────────────────
  if (sentTxHash && sentAmount !== null) {
    const txPreview = sentTxHash.length > 10 ? `${sentTxHash.slice(0, 10)}…` : sentTxHash
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#07090F' }}>
        <div style={{ width: '100%', maxWidth: 420, background: 'linear-gradient(180deg,rgba(18,20,32,.95) 0%,rgba(11,13,22,.98) 100%)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 32, padding: 40, textAlign: 'center', boxShadow: '0px 20px 60px rgba(0,0,0,.45)' }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(22,199,132,.1)', border: '1px solid rgba(22,199,132,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 8px' }}>Sent!</p>
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,.5)', margin: '0 0 24px', lineHeight: 1.5 }}>
            <span style={{ color: '#fff', fontWeight: 600 }}>{safeFormatUsdc(sentAmount)} USDC</span>{' '}sent to {safeDisplayName}
          </p>
          <a href={`https://testnet.arcscan.app/tx/${sentTxHash}`} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-block', fontSize: 12, fontFamily: 'monospace', color: 'rgba(255,255,255,.3)', marginBottom: 28, textDecoration: 'underline', textUnderlineOffset: 2 }}>
            {txPreview} · view on explorer
          </a>
          <button type="button" onClick={() => { setSentTxHash(null); setSentAmount(null) }}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16C784]"
            style={{ width: '100%', height: 60, borderRadius: 18, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#1ADE97 0%,#16C784 100%)', color: '#fff', fontSize: 16, fontWeight: 600, boxShadow: `0px 10px 24px ${ACCENT_GLOW}` }}>
            Send again
          </button>
        </div>
      </div>
    )
  }

  // ── Form ───────────────────────────────────────────────────────────────────────
  const cardBg   = 'linear-gradient(180deg,rgba(18,20,32,.95) 0%,rgba(11,13,22,.98) 100%)'
  const btnBg    = isDisabled ? 'rgba(255,255,255,.06)' : 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)'
  const btnColor = isDisabled ? 'rgba(255,255,255,.25)' : '#fff'

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: '#07090F' }}>
      <div style={{ width: '100%', maxWidth: 380 }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'radial-gradient(circle,#0F1B18 0%,#08100E 100%)', border: '1px solid rgba(22,199,132,.25)', boxShadow: '0 0 24px rgba(22,199,132,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 20, fontWeight: 700, color: ACCENT, userSelect: 'none' }}>
            {safeDisplayName.charAt(0).toUpperCase()}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 5px', letterSpacing: '-0.3px', lineHeight: 1.1 }}>
            Pay {safeDisplayName}
          </h1>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,.45)', fontFamily: 'monospace', letterSpacing: '.02em' }}>
              {shortAddress(recipientAddress)}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              title={copied ? 'Copied!' : 'Copy address'}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16C784] rounded-full p-0.5"
              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', lineHeight: 1 }}
            >
              <IconCopy active={copied} />
            </button>
          </div>
        </div>

        {/* Card */}
        <div style={{ background: cardBg, border: '1px solid rgba(255,255,255,.08)', borderRadius: 24, boxShadow: '0px 16px 40px rgba(0,0,0,.45)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', position: 'relative', overflow: 'hidden' }}>

          {/* Surface highlight */}
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, background: 'radial-gradient(circle at top left,rgba(255,255,255,.08),transparent 45%)' }} />

          <div style={{ position: 'relative', zIndex: 1, padding: '20px 20px 16px' }}>

            {hasNoBuckets && (
              <div role="alert" style={{ borderRadius: 12, background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.2)', padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'rgba(251,191,36,.9)', lineHeight: 1.5 }}>
                This recipient hasn&apos;t set up their payment rules yet and cannot receive funds.
              </div>
            )}

            <form onSubmit={handleSend} noValidate>

              {/* Amount input */}
              <div style={{ marginBottom: 10 }}>
                <label htmlFor="pay-amount" style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,.55)', marginBottom: 8, letterSpacing: '.02em' }}>
                  Amount
                </label>
                <div style={{ height: 60, borderRadius: 16, background: 'rgba(255,255,255,.02)', border: '1px solid rgba(22,199,132,.45)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,.04)', display: 'flex', alignItems: 'center', padding: '0 12px', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: '50%', border: '1.5px solid rgba(22,199,132,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                    </svg>
                  </div>
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
                    className="placeholder:text-white/20 focus:outline-none"
                    style={{ flex: 1, background: 'transparent', border: 'none', fontSize: 24, fontWeight: 600, color: '#fff', fontFamily: "'Inter','SF Pro Display',system-ui,sans-serif", width: '100%', minWidth: 0 }}
                  />
                  <div style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.06)', borderRadius: 10, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#fff', letterSpacing: '.03em' }}>USDC</span>
                    <IconChevronDown />
                  </div>
                </div>
              </div>

              {/* Balance */}
              {address && walletBal > 0n && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                  <IconWallet />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,.45)' }}>Balance:</span>
                  {/* formatUnits from viem returns a clean decimal string, safe for parseUnits on submit */}
                  <button
                    type="button"
                    onClick={() => setAmountStr(formatUnits(walletBal, 6))}
                    className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#16C784] rounded"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 600, color: ACCENT, fontFamily: 'monospace' }}
                  >
                    {safeFormatUsdc(walletBal)} USDC
                  </button>
                </div>
              )}

              {/* Note */}
              <div style={{ marginBottom: 16 }}>
                <label htmlFor="pay-note" style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,.55)', marginBottom: 8 }}>
                  Note <span style={{ fontWeight: 400, color: 'rgba(255,255,255,.25)' }}>(Optional)</span>
                </label>
                <div style={{ background: 'rgba(255,255,255,.03)', border: '1px solid rgba(255,255,255,.06)', borderRadius: 14, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 10, height: 42 }}>
                  <IconDoc />
                  <input
                    id="pay-note"
                    type="text"
                    placeholder="Invoice #001, project name, or any reference"
                    value={noteStr}
                    onChange={(e) => setNoteStr(e.target.value)}
                    className="placeholder:text-white/30 focus:outline-none"
                    style={{ flex: 1, background: 'transparent', border: 'none', fontSize: 13, color: '#fff', width: '100%', minWidth: 0 }}
                  />
                </div>
              </div>

              {error && (
                <p role="alert" style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 16, lineHeight: 1.5 }}>{error}</p>
              )}

              {!address ? (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <ConnectButton label="Connect wallet to send" />
                </div>
              ) : (
                <button
                  type="submit"
                  disabled={isDisabled}
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16C784] focus-visible:ring-offset-1 focus-visible:ring-offset-[#0B0D16]"
                  onMouseEnter={(e) => { if (!isDisabled) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.filter = 'brightness(1.05)' } }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = ''; e.currentTarget.style.filter = '' }}
                  style={{ width: '100%', height: 48, borderRadius: 14, border: 'none', cursor: isDisabled ? 'not-allowed' : 'pointer', background: btnBg, color: btnColor, fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'transform .15s ease, filter .15s ease' }}
                >
                  {step === 'idle' ? <IconSend /> : <IconSpinner />}
                  {btnLabel}
                </button>
              )}
            </form>
          </div>

          {/* Trust bar */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,.06)', background: 'rgba(255,255,255,.02)', padding: '14px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, borderRadius: '0 0 24px 24px', position: 'relative', zIndex: 1 }}>
            {TRUST_ITEMS.map(({ Icon, title, sub }) => (
              <div key={title} style={{ textAlign: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}><Icon /></div>
                <p style={{ margin: '0 0 2px', fontSize: 11, fontWeight: 600, color: '#fff', letterSpacing: '-.01em' }}>{title}</p>
                <p style={{ margin: 0, fontSize: 10, color: 'rgba(255,255,255,.35)', lineHeight: 1.4 }}>{sub}</p>
              </div>
            ))}
          </div>
        </div>

        <p style={{ textAlign: 'center', marginTop: 14, fontSize: 11, color: 'rgba(255,255,255,.2)' }}>
          Powered by{' '}
          <a href="/" className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#16C784] rounded" style={{ color: 'rgba(255,255,255,.35)', textDecoration: 'underline', textUnderlineOffset: 2 }}>Split</a>
        </p>
      </div>
    </div>
  )
}
