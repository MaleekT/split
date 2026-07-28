'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { ShieldCheck, Loader2, ScanLine, Eye, EyeOff, Globe, Copy, Check, Vault as VaultIcon } from 'lucide-react'
import { formatUnits } from 'viem'
import { formatUsdc, shortAddress } from '@/lib/format'
import { useStealth, type DetectedPayment, type ClaimAllProgress } from '@/hooks/use-stealth'
import { ClaimDialog } from '@/components/stealth/claim-dialog'

function fmt(raw: bigint): string {
  try { return formatUsdc(raw) } catch { return '?' }
}

/**
 * Dust amounts are smaller than formatUsdc's 2 decimal places, so it renders them
 * as a flat "0.00" - which reads as "empty" when the funds are real. Show enough
 * precision that a genuinely tiny amount is still legible as a number.
 */
function formatUsdcPrecise(raw: bigint): string {
  try {
    const s = formatUnits(raw, 6)
    // Only trim inside the fractional part. Trimming unconditionally would turn
    // a whole "10" into "1".
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s
  } catch { return '?' }
}

export default function PrivacyPage() {
  const { isConnected } = useAccount()
  const stealth = useStealth()

  const [enabled, setEnabled]   = useState<boolean | null>(null)
  const [handle, setHandle]     = useState<string | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [payments, setPayments] = useState<DetectedPayment[] | null>(null)
  const [claimTarget, setClaimTarget] = useState<DetectedPayment | null>(null)
  const [claimAllOpen, setClaimAllOpen]   = useState(false)
  const [claimingAll, setClaimingAll]     = useState(false)
  const [claimProgress, setClaimProgress] = useState<ClaimAllProgress | null>(null)
  const [claimAllError, setClaimAllError] = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const loadStatus = useCallback(async () => {
    if (!stealth.address) return
    const addr = encodeURIComponent(stealth.address)
    try {
      // Privacy status and handle load together: the private pay link needs the
      // handle, and showing the link a beat after the status reads as a glitch.
      const [statusRes, profileRes] = await Promise.all([
        fetch(`/api/stealth/${addr}`),
        fetch(`/api/profile?address=${addr}`),
      ])
      if (!statusRes.ok) throw new Error('status lookup failed')
      const body = await statusRes.json() as { data?: { metaAddress: string | null; linkToken: string | null } }
      if (mounted.current) {
        setEnabled(!!body.data?.metaAddress)
        setLinkToken(body.data?.linkToken ?? null)
      }
      if (profileRes.ok) {
        const p = await profileRes.json() as { data?: { handle: string | null } | null }
        if (mounted.current) setHandle(p.data?.handle ?? null)
      }
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

  // Dust is separated out everywhere: it is real money but permanently
  // unmovable, so it must not inflate the headline or enter a batch claim.
  const claimable      = (payments ?? []).filter((p) => !p.isDust)
  const dust           = (payments ?? []).filter((p) => p.isDust)
  const claimableTotal = claimable.reduce((acc, p) => acc + p.amountRaw, 0n)

  async function handleClaimAll(mode: 'quick' | 'private', useVault: boolean) {
    setClaimAllOpen(false)
    setClaimingAll(true); setClaimAllError(null); setClaimProgress(null)
    try {
      const outcomes = await stealth.claimAll(claimable, mode, useVault, (p) => {
        if (mounted.current) setClaimProgress(p)
      })
      const failed = outcomes.filter((o) => !o.ok)
      if (mounted.current && failed.length > 0) {
        // Partial success is normal and safe: anything unclaimed stays at its
        // stealth address and reappears on the next scan, so say so plainly
        // rather than implying the funds were lost.
        setClaimAllError(
          `${outcomes.length - failed.length} of ${outcomes.length} claimed. ` +
          `${failed.length} failed and ${failed.length === 1 ? 'is' : 'are'} still waiting: ${failed[0]?.error ?? 'unknown error'}`,
        )
      }
    } catch (e) {
      if (mounted.current) setClaimAllError(e instanceof Error ? e.message : 'Claim all failed')
    } finally {
      if (mounted.current) { setClaimingAll(false); setClaimProgress(null) }
      await handleScan()
    }
  }

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

      {/* Pay links: the two links are shown together so the difference between
          them is obvious at the moment of sharing, not buried in docs. */}
      {enabled && handle && <PayLinks handle={handle} linkToken={linkToken} />}

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
                  {/* Headline counts only what can actually be moved: including
                      unclaimable dust here would overstate the balance. */}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(claimableTotal)}</span>
                    <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                      USDC across {claimable.length} address{claimable.length === 1 ? '' : 'es'}
                    </span>
                  </div>

                  {claimable.length > 1 && (
                    <button type="button" onClick={() => setClaimAllOpen(true)} disabled={claimingAll}
                      style={{
                        width: '100%', height: 40, marginBottom: 4, borderRadius: 10, border: 'none',
                        cursor: claimingAll ? 'not-allowed' : 'pointer',
                        background: claimingAll ? 'var(--bg-3)' : 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)',
                        color: claimingAll ? 'var(--text-3)' : '#04110B', fontSize: 13, fontWeight: 700,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      }}>
                      {claimingAll
                        ? <><Loader2 size={14} className="animate-spin" /> Claiming {claimProgress?.position ?? 1} of {claimProgress?.total ?? claimable.length}…</>
                        : <>Claim all {claimable.length} payments</>}
                    </button>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {claimable.map((p) => (
                      <div key={p.stealthAddress} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 2px', borderTop: '0.5px solid var(--border)' }}>
                        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortAddress(p.stealthAddress)}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.amountRaw)} USDC</span>
                          <button type="button" onClick={() => setClaimTarget(p)} disabled={claimingAll}
                            style={{ height: 32, padding: '0 14px', borderRadius: 8, border: 'none', cursor: claimingAll ? 'not-allowed' : 'pointer', background: claimingAll ? 'var(--bg-3)' : 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)', color: claimingAll ? 'var(--text-3)' : '#04110B', fontSize: 12.5, fontWeight: 700 }}>
                            Claim
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Dust: real funds, but the claim's own gas reserve exceeds
                      them, so no claim can ever succeed. Shown rather than hidden
                      (the money is genuinely there) with the Claim action removed,
                      because offering it would only produce a failed transaction. */}
                  {dust.length > 0 && (
                    <div style={{ marginTop: 12, borderTop: '0.5px solid var(--border)', paddingTop: 10 }}>
                      <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 6, lineHeight: 1.5 }}>
                        Too small to claim. On Arc the gas for a claim is paid out of the payment itself, and these are
                        smaller than that cost, so they cannot be moved. Usually the remainder left behind by an earlier claim.
                      </p>
                      {dust.map((p) => (
                        <div key={p.stealthAddress} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '6px 2px', opacity: 0.55 }}>
                          <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortAddress(p.stealthAddress)}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                            {formatUsdcPrecise(p.amountRaw)} USDC
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {claimAllError && (
                    <p role="alert" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 10, lineHeight: 1.5 }}>{claimAllError}</p>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}

      {enabled && <VaultCard stealth={stealth} />}

      {/* Honest limitation */}
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 16, lineHeight: 1.5, maxWidth: 560 }}>
        Private payments hide <strong style={{ color: 'var(--text-2)' }}>which address</strong> received money, not <strong style={{ color: 'var(--text-2)' }}>how much</strong>. Amounts stay public. It protects your income trail, not a wallet you keep spending from.
      </p>

      {claimAllOpen && (
        <ClaimAllDialog
          count={claimable.length}
          totalRaw={claimableTotal}
          vaultReady={stealth.vaultAddress !== null}
          onCancel={() => setClaimAllOpen(false)}
          onConfirm={(mode, useVault) => { void handleClaimAll(mode, useVault) }}
        />
      )}

      {claimTarget && (
        <ClaimDialog
          payment={claimTarget}
          claim={stealth.claim}
          previewPrivateClaim={stealth.previewPrivateClaim}
          vaultAddress={stealth.vaultAddress}
          onClose={() => setClaimTarget(null)}
          onClaimed={() => { void handleScan() }}
        />
      )}
    </div>
  )
}

// ── Pay links ─────────────────────────────────────────────────────────────────

interface PayLinkRowProps {
  label:    string
  hint:     string
  href:     string
  tone:     'public' | 'private'
}

/**
 * Mode chooser for a batch claim. The same Quick/Private decision the single
 * claim dialog asks, chosen once and applied to every payment, and it states the
 * transaction count up front: each stealth address is a separate account, so a
 * batch is N transactions, not one. Nobody should start ten wallet-funded claims
 * expecting a single fee.
 */
function ClaimAllDialog({ count, totalRaw, vaultReady, onCancel, onConfirm }: {
  count: number
  totalRaw: bigint
  /** Vault already unlocked this session, so routing to it costs no extra signature. */
  vaultReady: boolean
  onCancel: () => void
  onConfirm: (mode: 'quick' | 'private', useVault: boolean) => void
}) {
  const [mode, setMode] = useState<'quick' | 'private'>('quick')
  // Default to using the Vault when it is already open. Otherwise default off, so
  // a bulk action never silently triggers signature prompts mid-run.
  const [useVault, setUseVault] = useState(vaultReady)

  return (
    <div role="dialog" aria-modal="true" aria-label="Claim all payments"
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 18, padding: 20 }}>
        <h2 style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>
          Claim {count} payments
        </h2>
        <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 14 }}>
          {fmt(totalRaw)} USDC in total. Each payment sits at its own one-time address, so this sends{' '}
          <strong style={{ color: 'var(--text)' }}>{count} separate transactions</strong>, one after another. Gas for each
          comes out of that payment.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          <ModeOption
            selected={mode === 'quick'} onSelect={() => setMode('quick')}
            title="Quick claim"
            body="Routes through your buckets exactly like a normal payment. Publicly links each one-time address to your account at claim time; who paid you stays hidden."
          />
          <ModeOption
            selected={mode === 'private'} onSelect={() => setMode('private')}
            title="Private claim"
            body="Sends straight to your bucket destinations, never touching the Split contract, so no event ties the addresses to your account. Costs more gas per payment."
          />
        </div>

        {/* Bulk claims must make the same Vault decision the single-claim dialog
            asks about, or hold portions would be skipped across every payment
            with no explanation. */}
        {mode === 'private' && (
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 13px', marginBottom: 16, borderRadius: 12, background: 'var(--bg-3)', border: `0.5px solid ${useVault ? 'rgba(139,124,246,.35)' : 'var(--border)'}`, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useVault}
              onChange={(e) => setUseVault(e.target.checked)}
              style={{ marginTop: 2, accentColor: '#8B7CF6', flexShrink: 0 }}
            />
            <span style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
              <strong style={{ color: 'var(--text)' }}>Also claim the portion your buckets hold.</strong>{' '}
              It goes to your Private Vault.{' '}
              {vaultReady
                ? 'Your Vault is already open, so this adds no extra signature.'
                : 'Setting up asks for two signatures once, before the run starts.'}{' '}
              Leave this off and that portion stays at each address, claimable later.
            </span>
          </label>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onCancel}
            style={{ flex: 1, height: 40, borderRadius: 10, border: '0.5px solid var(--border)', background: 'var(--bg-3)', color: 'var(--text-2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(mode, mode === 'private' && useVault)}
            style={{ flex: 2, height: 40, borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)', color: '#04110B', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
            Claim all {count}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModeOption({ selected, onSelect, title, body }: {
  selected: boolean; onSelect: () => void; title: string; body: string
}) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      style={{
        textAlign: 'left', padding: '11px 13px', borderRadius: 12, cursor: 'pointer',
        border: `0.5px solid ${selected ? 'var(--accent-border)' : 'var(--border)'}`,
        background: selected ? 'var(--accent-bg)' : 'var(--bg-3)',
      }}>
      <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: selected ? 'var(--accent)' : 'var(--text)', marginBottom: 2 }}>{title}</span>
      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.5 }}>{body}</span>
    </button>
  )
}

function PayLinks({ handle, linkToken }: { handle: string; linkToken: string | null }) {
  const [origin, setOrigin] = useState('')
  // window is unavailable during SSR; read it after mount so the links render
  // against the real deployment origin (preview URLs included).
  useEffect(() => { setOrigin(window.location.origin) }, [])

  const encoded = encodeURIComponent(handle)
  return (
    <section style={{ ...card(), marginTop: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Your pay links</h2>
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, marginBottom: 12 }}>
        Two separate links. Share whichever fits the payment - nothing to switch on or off.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {linkToken && (
          <PayLinkRow
            tone="private"
            label="Private link"
            hint="Each payment lands at a fresh one-time address only you can detect. The link looks ordinary - it does not reveal that it is private."
            href={`${origin}/pay/${linkToken}`}
          />
        )}
        <PayLinkRow
          tone="public"
          label="Normal link"
          hint="Ordinary transfer, publicly visible on-chain. Splits across your buckets."
          href={`${origin}/pay/${encoded}`}
        />
      </div>
      {!linkToken && (
        <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
          Your private link is still being set up. Reload in a moment, or turn private payments on again to generate it.
        </p>
      )}
    </section>
  )
}

// ── Private Vault ─────────────────────────────────────────────────────────────
// The Vault address is derived in the browser and held in session memory only. It
// is never sent to the server, logged, or stored, because publishing the
// main-address -> Vault mapping would let anyone watch the user's claimed private
// income. See the HARD RULE in lib/vault.ts.

function VaultCard({ stealth }: { stealth: ReturnType<typeof useStealth> }) {
  const [balance, setBalance] = useState<bigint | null>(null)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [movedTx, setMovedTx] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const address = stealth.vaultAddress

  // Serves both the first open and every later refresh. vaultBalance() unlocks
  // the Vault only if this session has not already, so re-checking a balance
  // costs no further signature. Needed because a claim that routes into the Vault
  // does not notify this card, leaving the figure stale until asked again.
  async function checkBalance() {
    setBusy(true); setError(null)
    try {
      const bal = await stealth.vaultBalance()
      if (mounted.current) setBalance(bal)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not open your Vault')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function consolidate() {
    setBusy(true); setError(null)
    try {
      const { txHash } = await stealth.consolidateVault()
      if (!mounted.current) return
      setMovedTx(txHash)
      setConfirming(false)
      setBalance(await stealth.vaultBalance())
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not move your Vault funds')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section style={{ ...card(), marginTop: 16, borderColor: 'rgba(139,124,246,.3)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(139,124,246,.12)', border: '0.5px solid rgba(139,124,246,.3)', color: '#8B7CF6' }}>
          <VaultIcon size={18} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Private Vault</h2>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.55 }}>
            Where the portion of a private payment your buckets hold in the contract goes. A Private Claim never touches the Split contract, so it needs a destination that is yours but is not your public wallet.
          </p>
        </div>
      </div>

      {error && <p role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 12, lineHeight: 1.5 }}>{error}</p>}

      {!address ? (
        <button type="button" onClick={() => void checkBalance()} disabled={busy}
          style={{ ...primaryBtn(!busy), marginTop: 14, background: busy ? 'var(--bg-3)' : 'linear-gradient(135deg,#6D5CE7 0%,#8B7CF6 100%)', color: busy ? 'var(--text-3)' : '#fff' }}>
          {busy ? 'Waiting for your wallet…' : 'Set up / open my Vault'}
        </button>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '11px 13px', borderRadius: 12, background: 'var(--bg-3)', border: '0.5px solid var(--border)' }}>
            <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {shortAddress(address)}
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {balance === null ? '...' : `${fmt(balance)} USDC`}
            </span>
          </div>

          {movedTx && (
            <p style={{ fontSize: 12, color: 'var(--accent)', lineHeight: 1.5 }}>
              Moved to your main wallet. <a href={`https://testnet.arcscan.app/tx/${movedTx}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>View transaction</a>
            </p>
          )}

          {/* Step 7: deliberate, never automatic, and never the default action. */}
          {!confirming ? (
            <div style={{ display: 'flex', gap: 8 }}>
              {/* On-demand refresh: a claim that routes into the Vault cannot tell
                  this card, so the figure above is only as fresh as the last check.
                  Costs no signature once the Vault is open for the session. */}
              <button type="button" onClick={() => void checkBalance()} disabled={busy} style={secondaryBtn()}>
                {busy ? 'Checking…' : 'Check Vault balance'}
              </button>
              <button type="button" onClick={() => setConfirming(true)} disabled={busy || balance === null || balance === 0n}
                style={{ ...secondaryBtn(), opacity: balance === null || balance === 0n ? 0.5 : 1 }}>
                Move to main wallet
              </button>
            </div>
          ) : (
            <div style={{ borderRadius: 12, border: '0.5px solid var(--danger-border, rgba(239,68,68,.35))', background: 'rgba(239,68,68,.06)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.55 }}>
                <strong>This publicly links your Vault to your main wallet.</strong> The transfer is visible on-chain, and because the Vault is one reused address, anyone who sees it can look back through everything it has ever received. That history cannot be un-linked afterwards.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setConfirming(false)} disabled={busy} style={secondaryBtn()}>Cancel</button>
                <button type="button" onClick={() => void consolidate()} disabled={busy}
                  style={{ ...secondaryBtn(), background: 'var(--danger)', color: '#fff', borderColor: 'transparent' }}>
                  {busy ? 'Moving…' : 'I understand, move it'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 8: what the Vault is and is not. Stated here rather than buried. */}
      <p style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 14, lineHeight: 1.55 }}>
        Your Vault is the <strong style={{ color: 'var(--text-2)' }}>same address every time</strong>, by design, so it is recoverable on any device by signing again. That reuse is also its limit: a persistent destination builds a noticeable pattern over time, so this is a real improvement over paying yourself in the open, not anonymity. Split can derive the key to spend from it, which is what makes claiming seamless, and also means it does not carry the separate confirmation step a standalone wallet app would give you.
      </p>
    </section>
  )
}

function PayLinkRow({ label, hint, href, tone }: PayLinkRowProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const accent = tone === 'private' ? '#8B7CF6' : 'var(--accent)'

  async function copy() {
    if (!href) return
    try {
      await navigator.clipboard.writeText(href)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2_000)
    } catch {
      // Clipboard can be blocked by permissions; the link stays selectable.
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 13px',
      borderRadius: 12, background: 'var(--bg-3)',
      border: `0.5px solid ${tone === 'private' ? 'rgba(139,124,246,.3)' : 'var(--border)'}`,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {tone === 'private' ? <EyeOff size={13} style={{ color: accent, flexShrink: 0 }} />
                              : <Globe size={13} style={{ color: 'var(--text-3)', flexShrink: 0 }} />}
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{label}</span>
          {/* The two links differ only by a URL suffix, so the mode is stated in
              words - never left to colour alone. */}
          <span style={{
            fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', padding: '2px 6px',
            borderRadius: 999, flexShrink: 0,
            background: tone === 'private' ? 'rgba(139,124,246,.14)' : 'var(--bg-2)',
            color:      tone === 'private' ? accent : 'var(--text-3)',
            border: `0.5px solid ${tone === 'private' ? 'rgba(139,124,246,.35)' : 'var(--border)'}`,
          }}>{tone === 'private' ? 'PRIVATE' : 'PUBLIC'}</span>
        </div>
        {/* On copy the hint is replaced by a confirmation that names the mode, so
            a distracted copy cannot be mistaken for the other link. */}
        <p role="status" aria-live="polite" style={{
          fontSize: 11.5, marginTop: 3, marginBottom: 5, lineHeight: 1.45,
          color: copied ? accent : 'var(--text-2)',
          fontWeight: copied ? 700 : 400,
        }}>
          {copied
            ? `Copied the ${label.toLowerCase()}: ${tone === 'private' ? 'payments here stay private' : 'payments here are public'}`
            : hint}
        </p>
        <span style={{
          display: 'block', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-3)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{href || ' '}</span>
      </div>
      <button type="button" onClick={copy} disabled={!href}
        aria-label={`Copy ${label.toLowerCase()}`}
        style={{
          height: 34, padding: '0 12px', borderRadius: 9, flexShrink: 0,
          border: `0.5px solid ${tone === 'private' ? 'rgba(139,124,246,.35)' : 'var(--border)'}`,
          background: 'var(--bg-2)', color: copied ? accent : 'var(--text-2)',
          fontSize: 12, fontWeight: 700, cursor: href ? 'pointer' : 'not-allowed',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

function card(): React.CSSProperties {
  return { background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 16, padding: 18 }
}
function badge(color: string): React.CSSProperties {
  return { width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-bg)', border: '0.5px solid var(--accent-border)', color, display: 'flex', alignItems: 'center', justifyContent: 'center' }
}
function secondaryBtn(): React.CSSProperties {
  return {
    flex: 1, height: 40, borderRadius: 10, border: '0.5px solid var(--border)',
    background: 'var(--bg-3)', color: 'var(--text)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
  }
}
function primaryBtn(enabled: boolean): React.CSSProperties {
  return { width: '100%', height: 44, borderRadius: 10, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', background: enabled ? 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)' : 'var(--bg-3)', color: enabled ? '#04110B' : 'var(--text-3)', fontSize: 14, fontWeight: 700 }
}
