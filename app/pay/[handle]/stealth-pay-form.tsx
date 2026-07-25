'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { parseUnits, formatUnits, parseSignature, isAddress } from 'viem'
import { useAccount, useDisconnect, useReadContracts, useSignTypedData, useWriteContract } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { USDC, erc20Abi, ZERO_ADDRESS } from '@/lib/contracts'
import { getStealthGatewayContract, stealthGatewayAbi } from '@/lib/stealth-contracts'
import {
  generateStealthPayment,
  buildAnnouncementMetadata,
  generateAuthorizationNonce,
  buildReceiveAuthorizationTypedData,
} from '@/lib/stealth'
import { publicClient } from '@/lib/arc'
import { parseSplitError } from '@/lib/errors'
import { shortAddress, formatUsdc, sanitizeDisplayName } from '@/lib/format'

// ── Icons ─────────────────────────────────────────────────────────────────────
// Duplicated from pay-form.tsx rather than shared, because extracting them would
// mean editing that file and it carries the live depositFor payment path. These
// are presentational only. Both pay pages must render identically, so any change
// here has to be mirrored there.

function IconSend() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
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

const TX_TIMEOUT_MS = 60_000
const AUTH_WINDOW_SECONDS = 3600n
// Deliberately the same green as the normal pay flow. This page must be
// indistinguishable from a normal pay link to the PAYER: only the recipient
// needs to know the link is private. A distinct violet accent (used elsewhere in
// the app for privacy) would itself advertise that the recipient uses privacy.
const ACCENT = '#16C784'

interface Props {
  recipientAddress: `0x${string}`
  displayName:      string
  metaAddress:      `0x${string}`
}

function safeFormatUsdc(val: bigint): string {
  try { return formatUsdc(val) } catch { return '?' }
}

export function StealthPayForm({ recipientAddress, displayName, metaAddress }: Props) {
  const { address }            = useAccount()
  const { disconnect }         = useDisconnect()
  // Same guard the normal pay link uses: a handle is attacker-influenced text
  // rendered to a payer, so strip spoofing characters before display.
  const safeDisplayName        = sanitizeDisplayName(displayName, shortAddress(recipientAddress))
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const { data } = useReadContracts({
    contracts: [
      { address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [address ?? ZERO_ADDRESS] },
    ],
    query: { refetchInterval: 30_000 },
  })
  const walletBal = (data?.[0]?.result ?? 0n) as bigint

  const [amountStr, setAmountStr] = useState('')
  const [step, setStep]           = useState<'idle' | 'signing' | 'sending'>('idle')
  const [error, setError]         = useState<string | null>(null)
  const [sentTx, setSentTx]       = useState<string | null>(null)
  const [sentAmount, setSentAmount] = useState<bigint | null>(null)

  const parsedAmount = useMemo<bigint | null>(() => {
    if (!amountStr.trim()) return null
    try { return parseUnits(amountStr.trim(), 6) } catch { return null }
  }, [amountStr])

  const isDisabled = step !== 'idle' || !parsedAmount
  const btnLabel = step === 'signing' ? 'Approve in wallet…' : step === 'sending' ? 'Sending…' : 'Send USDC'

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const amount = parsedAmount
    if (!amount || amount === 0n) { setError('Enter a valid USDC amount.'); return }
    if (!address)                 { setError('Connect your wallet.'); return }
    if (amount > walletBal)       { setError(`Insufficient balance. You have ${safeFormatUsdc(walletBal)} USDC.`); return }

    try {
      const gateway = getStealthGatewayContract()

      // 1. Compute a fresh one-time stealth address for the recipient.
      const payment  = generateStealthPayment(metaAddress)
      const metadata = buildAnnouncementMetadata(payment.viewTag)
      const nonce    = generateAuthorizationNonce()
      const validBefore = BigInt(Math.floor(Date.now() / 1000)) + AUTH_WINDOW_SECONDS

      // 2. One signature: authorize the gateway to pull exactly `amount`.
      setStep('signing')
      const typedData = buildReceiveAuthorizationTypedData({
        from: address, gateway, value: amount, validAfter: 0n, validBefore, nonce,
      })
      const sig = await signTypedDataAsync(typedData)
      const { r, s, v, yParity } = parseSignature(sig)
      const vNum = v !== undefined ? Number(v) : yParity + 27
      if (!mounted.current) return

      // 3. One atomic transaction: pull, forward to the stealth address, announce.
      setStep('sending')
      const tx = await writeContractAsync({
        address: gateway, abi: stealthGatewayAbi, functionName: 'payStealth',
        args: [
          { from: address, value: amount, validAfter: 0n, validBefore, nonce, v: vNum, r, s },
          { stealthAddress: payment.stealthAddress, ephemeralPubKey: payment.ephemeralPublicKey, metadata },
        ],
      })
      await publicClient.waitForTransactionReceipt({ hash: tx, pollingInterval: 500, timeout: TX_TIMEOUT_MS })
      if (mounted.current) { setSentTx(tx); setSentAmount(amount); setAmountStr('') }
    } catch (err) {
      let message = 'Something went wrong. Please try again.'
      try { message = parseSplitError(err) } catch {}
      if (mounted.current) setError(message)
    } finally {
      if (mounted.current) setStep('idle')
    }
  }

  if (!isAddress(recipientAddress)) {
    return (
      <div style={wrap}>
        <p style={{ fontSize: 14, color: '#FF6B6B' }}>Invalid recipient address.</p>
      </div>
    )
  }

  // ── Success ─────────────────────────────────────────────────────────────────
  if (sentTx && sentAmount !== null) {
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: 'center', padding: 40 }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(139,124,246,.12)', border: '1px solid rgba(139,124,246,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 8px' }}>Sent!</p>
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,.5)', margin: '0 0 24px', lineHeight: 1.5 }}>
            <span style={{ color: '#fff', fontWeight: 600 }}>{safeFormatUsdc(sentAmount)} USDC</span>{' '}sent to {safeDisplayName}
          </p>
          <a href={`https://testnet.arcscan.app/tx/${sentTx}`} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-block', fontSize: 12, fontFamily: 'monospace', color: 'rgba(255,255,255,.35)', marginBottom: 24, textDecoration: 'underline' }}>
            {sentTx.slice(0, 10)}… · view on explorer
          </a>
          <button type="button" onClick={() => { setSentTx(null); setSentAmount(null) }} style={btn(true)}>Send again</button>
        </div>
      </div>
    )
  }

  // ── Form ────────────────────────────────────────────────────────────────────
  return (
    <div style={wrap}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        {/* Header mirrors the normal pay link: no privacy badge, no privacy copy.
            The recipient's main address is deliberately NOT shown - it is not
            where this payment lands, so displaying it would be misleading. */}
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'radial-gradient(circle,#0F1B18 0%,#08100E 100%)', border: '1px solid rgba(22,199,132,.25)', boxShadow: '0 0 24px rgba(22,199,132,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', fontSize: 20, fontWeight: 700, color: ACCENT, userSelect: 'none' }}>
            {safeDisplayName.charAt(0).toUpperCase()}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 5px', letterSpacing: '-0.3px', lineHeight: 1.1 }}>
            Pay {safeDisplayName}
          </h1>
          {address && (
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => disconnect()}
                className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#16C784] rounded"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'rgba(255,255,255,.3)', padding: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,.6)' }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,.3)' }}
              >
                {shortAddress(address)} · Disconnect
              </button>
            </div>
          )}
        </div>

        <div style={card}>
          <div style={{ padding: '20px 20px 16px' }}>
            <form onSubmit={handleSend} noValidate>

              {/* Amount input - mirrors the normal pay link exactly */}
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

              {error && <p role="alert" style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 16, lineHeight: 1.5 }}>{error}</p>}

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
                  style={{ width: '100%', height: 48, borderRadius: 14, border: 'none', cursor: isDisabled ? 'not-allowed' : 'pointer', background: isDisabled ? 'rgba(255,255,255,.06)' : `linear-gradient(135deg,#12A971 0%,${ACCENT} 100%)`, color: isDisabled ? 'rgba(255,255,255,.3)' : '#04110B', fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'transform .15s ease, filter .15s ease' }}
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
        <p style={{ textAlign: 'center', marginTop: 14, fontSize: 11, color: 'rgba(255,255,255,.2)' }}>Powered by Split</p>
      </div>
    </div>
  )
}

const wrap: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#07090F' }
const card: React.CSSProperties = { width: '100%', maxWidth: 380, background: 'linear-gradient(180deg,rgba(20,18,32,.95) 0%,rgba(11,10,22,.98) 100%)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 24, boxShadow: '0 16px 40px rgba(0,0,0,.45)', overflow: 'hidden' }
function btn(enabled: boolean): React.CSSProperties {
  return { width: '100%', height: 48, borderRadius: 14, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', background: enabled ? 'linear-gradient(135deg,#6D5CE0 0%,#8B7CF6 100%)' : 'rgba(255,255,255,.06)', color: enabled ? '#fff' : 'rgba(255,255,255,.25)', fontSize: 15, fontWeight: 600 }
}
