'use client'

import { useEffect, useRef, useState } from 'react'
import { EyeOff, Globe, Copy, Check } from 'lucide-react'

// The two permanent pay links. Lives on Profile, beside the rest of a user's
// shareable identity, rather than on Privacy: they are not a privacy setting,
// they are two addresses that both exist all the time.

interface PayLinkRowProps {
  label:    string
  hint:     string
  href:     string
  tone:     'public' | 'private'
}

/**
 * Both links, side by side. Shown together on purpose: the difference between them
 * matters most at the moment of sharing, so it belongs there and not in docs.
 */
export function PayLinks({ handle, linkToken }: { handle: string; linkToken: string | null }) {
  const [origin, setOrigin] = useState('')
  // window is unavailable during SSR; read it after mount so the links render
  // against the real deployment origin (preview URLs included).
  useEffect(() => { setOrigin(window.location.origin) }, [])

  const encoded = encodeURIComponent(handle)
  return (
    <section style={card()}>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Your pay links</h2>
      <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, marginBottom: 12 }}>
        Two separate links. Share whichever fits the payment - nothing to switch on or off.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <PayLinkRow
          tone="public"
          label="Normal link"
          hint="Ordinary transfer, publicly visible on-chain. Splits across your buckets."
          href={`${origin}/pay/${encoded}`}
        />
        {linkToken && (
          <PayLinkRow
            tone="private"
            label="Private link"
            hint="Each payment lands at a fresh one-time address only you can detect. The link looks ordinary - it does not reveal that it is private."
            href={`${origin}/pay/${linkToken}`}
          />
        )}
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
