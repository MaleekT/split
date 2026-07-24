'use client'

import { useState } from 'react'
import { X, Zap, EyeOff, Loader2, Check, ArrowRight } from 'lucide-react'
import { formatUsdc, shortAddress } from '@/lib/format'
import type { DetectedPayment } from '@/hooks/use-stealth'
import type { QuickClaimResult, PrivateClaimResult } from '@/lib/stealth-claim'

type Mode = 'quick' | 'private'
type Phase = 'choose' | 'claiming' | 'done' | 'error'

interface Props {
  payment: DetectedPayment
  claim: (payment: DetectedPayment, mode: Mode) => Promise<QuickClaimResult | PrivateClaimResult>
  onClose: () => void
  onClaimed: () => void
}

function fmt(raw: bigint): string { try { return formatUsdc(raw) } catch { return '?' } }

// Each mode's real privacy consequence, stated at the moment of choice.
const MODES: Record<Mode, { icon: typeof Zap; title: string; sub: string; consequence: string }> = {
  quick: {
    icon: Zap,
    title: 'Quick Claim',
    sub: 'One tap, routes through your buckets',
    consequence:
      'Sends the payment through Split so your buckets fill automatically, exactly like a normal payment. It publicly links this one address to your account on-chain, but never reveals who paid you.',
  },
  private: {
    icon: EyeOff,
    title: 'Private Claim',
    sub: 'Maximum privacy, splits without touching Split',
    consequence:
      'Distributes to your buckets with direct transfers that never touch the Split contract, so no single event links this address to you. Weaker than it sounds: timing and amounts are still statistically correlatable, and any hold-bucket funds land at your main address (a partial link). Choose this only if that trade-off is worth it to you.',
  },
}

export function ClaimDialog({ payment, claim, onClose, onClaimed }: Props) {
  const [mode, setMode]   = useState<Mode>('quick')
  const [phase, setPhase] = useState<Phase>('choose')
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setPhase('claiming'); setError(null)
    try {
      await claim(payment, mode)
      setPhase('done')
      onClaimed()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claim failed')
      setPhase('error')
    }
  }

  const chosen = MODES[mode]

  return (
    <div role="dialog" aria-modal="true" aria-label="Claim private payment"
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget && phase !== 'claiming') onClose() }}>
      <div style={{ width: '100%', maxWidth: 480, background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 18, boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '0.5px solid var(--border)' }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Claim {fmt(payment.amountRaw)} USDC</h2>
            <p style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>from {shortAddress(payment.stealthAddress)}</p>
          </div>
          {phase !== 'claiming' && (
            <button type="button" aria-label="Close" onClick={onClose} style={{ color: 'var(--text-3)', padding: 4 }}><X size={18} /></button>
          )}
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {phase === 'choose' && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(Object.keys(MODES) as Mode[]).map((m) => {
                  const info = MODES[m]; const active = mode === m; const Icon = info.icon
                  return (
                    <button key={m} type="button" onClick={() => setMode(m)}
                      style={{ textAlign: 'left', display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12,
                        border: '1px solid ' + (active ? 'var(--accent-border)' : 'var(--border)'),
                        background: active ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer' }}>
                      <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: active ? 'var(--accent)' : 'var(--bg-3)', color: active ? '#04110B' : 'var(--text-2)' }}>
                        <Icon size={16} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{info.title}</p>
                        <p style={{ fontSize: 12, color: 'var(--text-2)' }}>{info.sub}</p>
                      </div>
                    </button>
                  )
                })}
              </div>

              {/* The consequence of the currently selected mode, always visible before confirming. */}
              <div style={{ background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 12, padding: '12px 14px' }}>
                <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>{chosen.consequence}</p>
              </div>

              <button type="button" onClick={run}
                style={{ width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)', color: '#04110B', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                {chosen.title} <ArrowRight size={16} />
              </button>
            </>
          )}

          {phase === 'claiming' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text)', fontSize: 14, padding: '18px 0', justifyContent: 'center' }}>
              <Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent)' }} />
              {mode === 'quick' ? 'Routing through your buckets…' : 'Distributing to your buckets…'}
            </div>
          )}

          {phase === 'done' && (
            <div style={{ textAlign: 'center', padding: '16px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 50, height: 50, borderRadius: 999, background: 'var(--accent-bg)', border: '1px solid var(--accent-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Check size={22} style={{ color: 'var(--accent)' }} />
              </div>
              <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Claimed</p>
              <p style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 320 }}>
                {mode === 'quick' ? 'The payment ran through your buckets.' : 'The payment was distributed to your buckets directly.'}
              </p>
              <button type="button" onClick={onClose} style={{ height: 40, padding: '0 20px', borderRadius: 10, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)', color: '#04110B', fontSize: 13, fontWeight: 700 }}>Done</button>
            </div>
          )}

          {phase === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', lineHeight: 1.5 }}>{error ?? 'Something went wrong.'}</p>
              <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Any funds that did not move are still at the stealth address and can be claimed again.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setPhase('choose')} style={btnSecondary()}>Back</button>
                <button type="button" onClick={onClose} style={btnSecondary()}>Close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function btnSecondary(): React.CSSProperties {
  return { flex: 1, height: 40, borderRadius: 10, border: '0.5px solid var(--border)', background: 'var(--bg-3)', color: 'var(--text)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
}
