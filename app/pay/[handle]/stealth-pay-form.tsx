'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { parseUnits, formatUnits, parseSignature, isAddress } from 'viem'
import { useAccount, useReadContracts, useSignTypedData, useWriteContract } from 'wagmi'
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
import { shortAddress, formatUsdc } from '@/lib/format'

const TX_TIMEOUT_MS = 60_000
const AUTH_WINDOW_SECONDS = 3600n
const ACCENT = '#8B7CF6' // violet, the privacy accent, distinct from the green pay flow

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
  const btnLabel = step === 'signing' ? 'Approve in wallet…' : step === 'sending' ? 'Sending…' : 'Send privately'

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
          <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 8px' }}>Sent privately</p>
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,.55)', margin: '0 0 8px', lineHeight: 1.5 }}>
            <span style={{ color: '#fff', fontWeight: 600 }}>{safeFormatUsdc(sentAmount)} USDC</span> to {displayName}
          </p>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,.4)', margin: '0 0 24px', lineHeight: 1.5 }}>
            It landed at a fresh one-time address. Nothing on-chain links it to {displayName}.
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
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(139,124,246,.1)', border: '1px solid rgba(139,124,246,.3)', borderRadius: 999, padding: '4px 12px', marginBottom: 12 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span style={{ fontSize: 11, fontWeight: 700, color: ACCENT, letterSpacing: '.02em' }}>PRIVATE PAYMENT</span>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 5px' }}>Pay {displayName}</h1>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,.45)', fontFamily: 'monospace' }}>{shortAddress(recipientAddress)}</span>
        </div>

        <div style={card}>
          <div style={{ padding: '20px 20px 16px' }}>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,.5)', lineHeight: 1.5, marginBottom: 16 }}>
              This payment lands at a brand-new one-time address only {displayName} can detect. On-chain, it looks unrelated to them or to your other payments.
            </p>
            <form onSubmit={handleSend} noValidate>
              <label htmlFor="amt" style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,.55)', marginBottom: 8 }}>Amount</label>
              <div style={{ height: 60, borderRadius: 16, background: 'rgba(255,255,255,.02)', border: `1px solid rgba(139,124,246,.45)`, display: 'flex', alignItems: 'center', padding: '0 14px', gap: 10, marginBottom: 10 }}>
                <input id="amt" type="number" inputMode="decimal" min="0.000001" step="0.000001" placeholder="0.00" required autoFocus
                  value={amountStr} onChange={(e) => setAmountStr(e.target.value)}
                  className="focus:outline-none" style={{ flex: 1, background: 'transparent', border: 'none', fontSize: 24, fontWeight: 600, color: '#fff', width: '100%', minWidth: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>USDC</span>
              </div>

              {address && walletBal > 0n && (
                <button type="button" onClick={() => setAmountStr(formatUnits(walletBal, 6))}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 14, fontSize: 12, fontWeight: 600, color: ACCENT, fontFamily: 'monospace' }}>
                  Balance: {safeFormatUsdc(walletBal)} USDC
                </button>
              )}

              {error && <p role="alert" style={{ fontSize: 13, color: '#FF6B6B', marginBottom: 14, lineHeight: 1.5 }}>{error}</p>}

              {!address ? (
                <div style={{ display: 'flex', justifyContent: 'center' }}><ConnectButton label="Connect wallet to send" /></div>
              ) : (
                <button type="submit" disabled={isDisabled} style={btn(!isDisabled)}>{btnLabel}</button>
              )}
            </form>
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,.06)', padding: '12px 20px', fontSize: 11, color: 'rgba(255,255,255,.4)', lineHeight: 1.5 }}>
            One signature, one transaction. Amounts remain public. This hides who is paid, not how much.
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
