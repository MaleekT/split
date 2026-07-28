'use client'

import { useState } from 'react'
import { X, Zap, EyeOff, Loader2, Check, ArrowRight, Vault } from 'lucide-react'
import { formatUsdc, shortAddress } from '@/lib/format'
import type { DetectedPayment } from '@/hooks/use-stealth'
import type { QuickClaimResult, PrivateClaimResult } from '@/lib/stealth-claim'

type Mode = 'quick' | 'private'
type Phase = 'choose' | 'vault' | 'claiming' | 'done' | 'error'

interface Props {
  payment: DetectedPayment
  claim: (payment: DetectedPayment, mode: Mode, useVault?: boolean) => Promise<QuickClaimResult | PrivateClaimResult>
  /** Whether this payment has a hold portion that needs a Vault to receive it. */
  previewPrivateClaim: (payment: DetectedPayment) => Promise<{ holdPortionRaw: bigint; needsVault: boolean }>
  /** Vault address if already unlocked this session; null means a signature is needed. */
  vaultAddress: `0x${string}` | null
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
      'Distributes to your buckets with direct transfers that never touch the Split contract, so no single event links this address to you. Weaker than it sounds: timing and amounts are still statistically correlatable. Anything your buckets hold in the contract goes to your Private Vault instead, or waits at this address until you set one up. It is never sent to your main wallet.',
  },
}

export function ClaimDialog({
  payment, claim, previewPrivateClaim, vaultAddress, onClose, onClaimed,
}: Props) {
  const [mode, setMode]       = useState<Mode>('quick')
  const [phase, setPhase]     = useState<Phase>('choose')
  const [error, setError]     = useState<string | null>(null)
  const [holdRaw, setHoldRaw] = useState<bigint>(0n)
  // What actually happened, so the outcome can report it instead of guessing.
  const [moved, setMoved]     = useState<bigint>(0n)
  const [deferred, setDeferred] = useState<bigint>(0n)

  // Start the chosen mode. Quick Claim never needs a Vault. Private Claim asks
  // only when this payment genuinely has a hold portion, so a user whose buckets
  // are all auto-send is never prompted for a signature they do not need.
  async function start() {
    setError(null)
    if (mode === 'quick') return run(false)
    try {
      const { holdPortionRaw, needsVault } = await previewPrivateClaim(payment)
      if (!needsVault) return run(false)
      setHoldRaw(holdPortionRaw)
      // Already unlocked this session: route to it without asking again.
      if (vaultAddress) return run(true)
      setPhase('vault')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read your buckets')
      setPhase('error')
    }
  }

  async function run(useVault: boolean) {
    setPhase('claiming'); setError(null)
    try {
      const result = await claim(payment, mode, useVault)
      setMoved('amountRaw' in result ? result.amountRaw : 0n)
      setDeferred('deferredRaw' in result ? result.deferredRaw : 0n)
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

              <button type="button" onClick={() => void start()}
                style={{ width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)', color: '#04110B', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                {chosen.title} <ArrowRight size={16} />
              </button>
            </>
          )}

          {/* A hold portion exists but the Vault is not unlocked. Always two ways
              forward, so this is a choice rather than a dead end. */}
          {phase === 'vault' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(139,124,246,.14)', color: '#8B7CF6' }}>
                  <Vault size={16} />
                </div>
                <div style={{ minWidth: 0 }}>
                  {/* Planned against the gross payment; the settled figure is a
                      little lower once this claim's gas is reserved, hence "about". */}
                  <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                    About {fmt(holdRaw)} USDC of this payment holds in your contract
                  </p>
                  <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55, marginTop: 4 }}>
                    A Private Claim never touches the Split contract, so that portion needs somewhere else to land. Your Private Vault is an address only you can derive. Without it, that portion stays where it is.
                  </p>
                </div>
              </div>

              <div style={{ background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 12, padding: '12px 14px' }}>
                <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
                  Setting up asks for <strong style={{ color: 'var(--text)' }}>two signatures</strong>. Split signs the same request twice and compares: a wallet that signs unpredictably would produce a different Vault later and strand whatever was sent to the first one. Checking now is what prevents that.
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button type="button" onClick={() => void run(true)}
                  style={{ width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#6D5CE7 0%,#8B7CF6 100%)', color: '#fff', fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Vault size={16} /> Set up Vault and claim all
                </button>
                <button type="button" onClick={() => void run(false)} style={btnSecondary()}>
                  Claim the rest now, leave {fmt(holdRaw)} for later
                </button>
              </div>
            </div>
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
              <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                {deferred > 0n ? 'Partly claimed' : 'Claimed'}
              </p>
              {/* Reports what actually moved. The old copy said "distributed to your
                  buckets" even when every cent went somewhere else, which is the
                  confusion this replaces. */}
              <p style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 340, lineHeight: 1.55 }}>
                {mode === 'quick'
                  ? 'The payment ran through your buckets.'
                  : moved > 0n
                    ? `${fmt(moved)} USDC moved to your bucket destinations${vaultAddress ? ' and your Vault' : ''}.`
                    : 'Nothing moved yet.'}
              </p>
              {deferred > 0n && (
                <p style={{ fontSize: 12.5, color: 'var(--text-2)', maxWidth: 340, lineHeight: 1.55, background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                  <strong style={{ color: 'var(--text)' }}>{fmt(deferred)} USDC stayed where it is.</strong> That is the portion your buckets hold in the contract, and it needs a Private Vault to receive it. It is not lost: the next scan finds it again, and you can claim it once a Vault is set up.
                </p>
              )}
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
