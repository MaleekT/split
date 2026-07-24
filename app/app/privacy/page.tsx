'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { ShieldCheck, Loader2, ScanLine, Eye } from 'lucide-react'
import { formatUsdc, shortAddress } from '@/lib/format'
import { useStealth, type DetectedPayment } from '@/hooks/use-stealth'
import { ClaimDialog } from '@/components/stealth/claim-dialog'

function fmt(raw: bigint): string {
  try { return formatUsdc(raw) } catch { return '?' }
}

export default function PrivacyPage() {
  const { isConnected } = useAccount()
  const stealth = useStealth()

  const [enabled, setEnabled]   = useState<boolean | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [payments, setPayments] = useState<DetectedPayment[] | null>(null)
  const [claimTarget, setClaimTarget] = useState<DetectedPayment | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const loadStatus = useCallback(async () => {
    if (!stealth.address) return
    try {
      const r = await fetch(`/api/stealth/${encodeURIComponent(stealth.address)}`)
      const body = await r.json() as { data?: { metaAddress: string | null } }
      if (mounted.current) setEnabled(!!body.data?.metaAddress)
    } catch {
      if (mounted.current) setEnabled(false)
    }
  }, [stealth.address])

  useEffect(() => { if (isConnected) loadStatus() }, [isConnected, loadStatus])

  async function handleEnable() {
    setEnabling(true); setError(null)
    try {
      await stealth.enablePrivacy()
      if (mounted.current) setEnabled(true)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Failed to enable private payments')
    } finally {
      if (mounted.current) setEnabling(false)
    }
  }

  async function handleScan() {
    setScanning(true); setError(null)
    try {
      const found = await stealth.scan()
      if (mounted.current) setPayments(found)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      if (mounted.current) setScanning(false)
    }
  }

  const total = (payments ?? []).reduce((acc, p) => acc + p.amountRaw, 0n)

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.02em' }}>Private payments</h1>
        <p style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 2 }}>
          Let people pay your link without leaving a public trail that ties every payment back to you.
        </p>
      </header>

      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 12 }}>{error}</p>}

      {/* Enable / status */}
      <section style={card()}>
        {enabled === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 12, color: 'var(--text-3)' }}><Loader2 className="animate-spin" size={18} /></div>
        ) : enabled ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={badge('var(--accent)')}><ShieldCheck size={18} /></div>
            <div>
              <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Private payments are on</p>
              <p style={{ fontSize: 13, color: 'var(--text-2)' }}>Your pay link now receives at fresh one-time addresses only you can detect.</p>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={badge('var(--accent)')}><ShieldCheck size={18} /></div>
              <div>
                <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Turn on private payments</p>
                <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
                  You&apos;ll sign a message to create your private receiving keys (they stay on your device), then publish a one-time meta-address. After that, anyone paying your link pays privately.
                </p>
              </div>
            </div>
            <button type="button" onClick={handleEnable} disabled={enabling} style={primaryBtn(!enabling)}>
              {enabling ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}><Loader2 size={15} className="animate-spin" /> Setting up…</span> : 'Enable private payments'}
            </button>
          </div>
        )}
      </section>

      {/* Private balance */}
      {enabled && (
        <section style={{ ...card(), marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Private balance</h2>
              <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Scan the chain locally to find payments only you can see.</p>
            </div>
            <button type="button" onClick={handleScan} disabled={scanning}
              style={{ ...primaryBtn(!scanning), width: 'auto', padding: '0 16px', height: 40, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {scanning ? <Loader2 size={15} className="animate-spin" /> : <ScanLine size={15} />}
              {scanning ? 'Scanning…' : 'Scan for payments'}
            </button>
          </div>

          {payments !== null && (
            <>
              {payments.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-3)', fontSize: 13 }}>
                  <Eye size={20} style={{ opacity: 0.5, marginBottom: 6 }} /><br />No private payments found yet.
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(total)}</span>
                    <span style={{ fontSize: 13, color: 'var(--text-2)' }}>USDC across {payments.length} address{payments.length > 1 ? 'es' : ''}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {payments.map((p) => (
                      <div key={p.stealthAddress} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 2px', borderTop: '0.5px solid var(--border)' }}>
                        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortAddress(p.stealthAddress)}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amountRaw)} USDC</span>
                          <button type="button" onClick={() => setClaimTarget(p)}
                            style={{ height: 32, padding: '0 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)', color: '#04110B', fontSize: 12.5, fontWeight: 700 }}>
                            Claim
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {/* Honest limitation */}
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 16, lineHeight: 1.5, maxWidth: 560 }}>
        Private payments hide <strong style={{ color: 'var(--text-2)' }}>which address</strong> received money, not <strong style={{ color: 'var(--text-2)' }}>how much</strong>. Amounts stay public. It protects your income trail, not a wallet you keep spending from.
      </p>

      {claimTarget && (
        <ClaimDialog
          payment={claimTarget}
          claim={stealth.claim}
          onClose={() => setClaimTarget(null)}
          onClaimed={() => { void handleScan() }}
        />
      )}
    </div>
  )
}

function card(): React.CSSProperties {
  return { background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 16, padding: 18 }
}
function badge(color: string): React.CSSProperties {
  return { width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-bg)', border: '0.5px solid var(--accent-border)', color, display: 'flex', alignItems: 'center', justifyContent: 'center' }
}
function primaryBtn(enabled: boolean): React.CSSProperties {
  return { width: '100%', height: 44, borderRadius: 10, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', background: enabled ? 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)' : 'var(--bg-3)', color: enabled ? '#04110B' : 'var(--text-3)', fontSize: 14, fontWeight: 700 }
}
