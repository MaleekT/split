'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { useAccount, useSignMessage } from 'wagmi'
import { isValidHandle } from '@/lib/handle'
import { Camera, Copy, Share2, SquarePen, QrCode } from 'lucide-react'
import QRCode from 'qrcode'
import { QrModal } from '@/components/qr-modal'
import { PayLinks } from '@/components/pay-links'

type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'invalid'

const MAX_AVATAR_BYTES = 1_048_576
const ALLOWED_TYPES    = ['image/jpeg', 'image/png', 'image/webp'] as const

/* ── Page-scoped CSS ────────────────────────────────────────────────────── */
const PAGE_CSS = `
@keyframes pr-spin { to { transform:rotate(360deg); } }

/* ── Page wrapper ── */
.pr-page { max-width:960px; display:flex; flex-direction:column; }

/* ── Identity block: centered, top of page, avatar is the focal point ── */
.pr-identity { display:flex; flex-direction:column; align-items:center; gap:12px; margin-bottom:18px; }

.pr-avatar-btn {
  position:relative; flex-shrink:0; width:88px; height:88px; border-radius:50%;
  overflow:hidden; cursor:pointer; border:none; padding:0;
  background:linear-gradient(135deg, var(--accent), #60A5FA);
  display:flex; align-items:center; justify-content:center;
  font-size:30px; font-weight:700; color:#fff;
}
.pr-avatar-btn:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.pr-avatar-overlay {
  position:absolute; inset:0; z-index:2; background:rgba(0,0,0,0.52);
  display:flex; align-items:center; justify-content:center; opacity:0; transition:opacity 0.2s;
}
@media (hover:hover) {
  .pr-avatar-btn:hover .pr-avatar-overlay { opacity:1; }
}
.pr-avatar-btn:focus-visible .pr-avatar-overlay { opacity:1; }
.pr-avatar-spinner {
  position:absolute; inset:0; z-index:3; background:rgba(0,0,0,0.5);
  display:flex; align-items:center; justify-content:center;
}
.pr-spin-ring {
  width:22px; height:22px; border-radius:50%;
  border:2.5px solid rgba(255,255,255,0.25); border-top-color:#fff;
  animation:pr-spin 0.7s linear infinite;
}
/* Always visible, on top of the avatar - tells a first-time visitor with no
   avatar yet that the circle is clickable, not just decoration. */
.pr-avatar-pencil {
  position:absolute; z-index:4; right:0; bottom:0;
  width:26px; height:26px; border-radius:50%;
  background:var(--bg-2); border:2px solid var(--bg);
  display:flex; align-items:center; justify-content:center;
  color:var(--text-2); pointer-events:none;
}

.pr-identity-hint { font-size:13px; color:var(--text-3); }
.pr-identity-handle-btn {
  background:none; border:0.5px solid transparent; border-radius:10px;
  padding:6px 16px; font-size:19px; font-weight:700; color:var(--text);
  cursor:pointer; font-family:inherit; transition:background 0.15s, border-color 0.15s;
}
@media (hover:hover) {
  .pr-identity-handle-btn:hover { background:var(--bg-3); border-color:var(--border); }
}
.pr-identity-handle-btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

/* Handle edit: a single plain input, nothing else. Enter saves, Escape or
   clicking away cancels - no separate label or buttons to manage. */
.pr-form-wrap { display:flex; flex-direction:column; align-items:center; gap:6px; margin-bottom:28px; }
.pr-handle-solo {
  width:220px; text-align:center; padding:10px 14px;
  border:1px solid var(--border); border-radius:10px;
  background:var(--bg-2); color:var(--text); font-size:16px; font-weight:600;
  font-family:var(--font-jetbrains-mono,monospace);
  outline:none; transition:border-color 0.15s;
}
.pr-handle-solo:focus { border-color:var(--accent); }
.pr-handle-solo.pr-handle-ok  { border-color:var(--accent); }
.pr-handle-solo.pr-handle-err { border-color:#EF4444; }
.pr-form-error { font-size:12px; color:#EF4444; text-align:center; }

/* ── Content grid: pay links carry the page, share and QR sit lighter beside them.
   Both columns are stretched to the same height; pay links is the only one that
   scrolls internally if it ever outgrows that height, share/QR just render. ── */
.pr-content { display:grid; grid-template-columns:3fr 2fr; gap:16px; align-items:stretch; }
.pr-links-col { min-height:0; }
.pr-side { display:flex; flex-direction:column; gap:16px; min-height:0; }

.pr-card { background:var(--bg-2); border:0.5px solid var(--border); border-radius:16px; padding:18px; }
.pr-card-title { margin:0 0 12px; font-size:16px; font-weight:700; color:var(--text); }

/* ── Share card ── */
.pr-share-code {
  display:flex; align-items:flex-start; gap:12px;
  background:rgba(0,0,0,0.08); border:0.5px solid var(--border);
  border-radius:10px; padding:14px 16px;
}
.dark .pr-share-code { background:rgba(0,0,0,0.32); }
.pr-share-code-text {
  flex:1; font-size:13px; line-height:1.6;
  font-family:var(--font-jetbrains-mono,monospace); color:var(--text-2);
}
.pr-share-copy-btn {
  flex-shrink:0; background:none; border:0.5px solid var(--border);
  border-radius:6px; padding:6px; cursor:pointer; color:var(--text-3);
  display:flex; align-items:center; justify-content:center;
  transition:color 0.15s, border-color 0.15s; margin-top:2px;
}
@media (hover:hover) {
  .pr-share-copy-btn:hover { color:var(--accent); border-color:var(--accent); }
}
.pr-social-row { display:flex; gap:10px; align-items:center; margin-top:14px; }
.pr-social-btn {
  width:44px; height:44px; border-radius:50%;
  border:0.5px solid var(--border); background:var(--bg-3);
  display:flex; align-items:center; justify-content:center;
  cursor:pointer; position:relative; flex-shrink:0;
  transition:transform 0.2s, box-shadow 0.2s;
}
@media (hover:hover) {
  .pr-social-btn:hover { transform:translateY(-2px); }
  .pr-social-btn[data-p="twitter"]:hover   { box-shadow:0 0 0 2px #1DA1F2, 0 4px 16px rgba(29,161,242,0.30); }
  .pr-social-btn[data-p="whatsapp"]:hover  { box-shadow:0 0 0 2px #25D366, 0 4px 16px rgba(37,211,102,0.30); }
  .pr-social-btn[data-p="instagram"]:hover { box-shadow:0 0 0 2px #E1306C, 0 4px 16px rgba(225,48,108,0.30); }
  .pr-social-btn[data-p="share"]:hover     { box-shadow:0 0 0 2px var(--accent), 0 4px 16px rgba(29,158,117,0.30); }
}
.pr-social-toast {
  position:absolute; bottom:-20px; left:50%; transform:translateX(-50%);
  font-size:10px; font-weight:500; white-space:nowrap; color:var(--accent);
  pointer-events:none;
}

/* ── QR card ── */
.pr-qr-btn {
  display:block; width:100%; border:none; background:none; padding:0; cursor:pointer;
  border-radius:10px;
}
.pr-qr-btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.pr-qr-img-wrap {
  background:#fff; border-radius:10px; padding:12px;
  display:flex; align-items:center; justify-content:center;
}
.pr-qr-skel { width:100%; aspect-ratio:1; background:var(--bg-3); border-radius:6px; }
.pr-qr-caption {
  display:flex; align-items:center; justify-content:center; gap:6px;
  margin-top:10px; font-size:12px; color:var(--text-3);
}

/* ── Desktop only: cap the grid to the space left in the viewport so pay links
   scrolls internally instead of the whole page growing past one screen. On
   mobile a single scrolling column is the simpler, more standard pattern. ── */
@media (min-width:769px) {
  .pr-page { height:100%; }
  .pr-content { flex:1; min-height:0; }
  /* Scroll stays functional (wheel, trackpad, keyboard); the scrollbar track
     itself is just never drawn. */
  .pr-links-col, .pr-side {
    overflow-y:auto; scrollbar-width:none; -ms-overflow-style:none;
  }
  .pr-links-col::-webkit-scrollbar, .pr-side::-webkit-scrollbar { display:none; }
}

/* ── Responsive ── */
@media (max-width:768px) {
  .pr-content { grid-template-columns:1fr; }
}
`

export default function ProfilePage() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  /* ── refs ─────────────────────────────────────────────────────────── */
  const mounted     = useRef(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef     = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  /* ── state ────────────────────────────────────────────────────────── */
  const [savedHandle,  setSavedHandle]  = useState<string | null>(null)
  const [avatarUrl,    setAvatarUrl]    = useState<string | null>(null)
  const [handleInput,  setHandleInput]  = useState('')
  const [availability, setAvailability] = useState<Availability>('idle')
  const [saving,    setSaving]    = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [editingHandle, setEditingHandle] = useState(false)

  const [payLinkToken, setPayLinkToken] = useState<string | null>(null)
  const [copiedLink,    setCopiedLink]    = useState(false)
  const [igCopied,      setIgCopied]      = useState(false)
  const [qrDataUrl,     setQrDataUrl]     = useState<string | null>(null)
  const [qrModalOpen,   setQrModalOpen]   = useState(false)

  const showForm = !savedHandle || editingHandle

  /* ── load profile ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!address) return
    fetch(`/api/profile?address=${encodeURIComponent(address)}`)
      .then((r) => r.json())
      .then(({ data }: { data: { handle?: string; avatar_url?: string } | null }) => {
        if (!mounted.current) return
        if (data?.handle)     { setSavedHandle(data.handle); setHandleInput(data.handle) }
        if (data?.avatar_url) setAvatarUrl(data.avatar_url)
      })
      .catch(() => {})
  }, [address])

  /* ── debounced availability check ─────────────────────────────────── */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = handleInput.trim()
    if (!trimmed)                { setAvailability('idle');      return }
    if (!isValidHandle(trimmed)) { setAvailability('invalid');   return }
    if (trimmed === savedHandle) { setAvailability('available'); return }
    setAvailability('checking')
    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null
      try {
        const r    = await fetch(`/api/profile/check?handle=${encodeURIComponent(trimmed)}`)
        const body = await r.json() as { available?: boolean }
        if (mounted.current) setAvailability(body.available ? 'available' : 'taken')
      } catch {
        if (mounted.current) setAvailability('idle')
      }
    }, 500)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [handleInput, savedHandle])

  /* ── QR generation ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!savedHandle) { setQrDataUrl(null); return }
    let cancelled = false
    QRCode.toDataURL(`https://split.app/pay/${savedHandle}`, { width: 200, margin: 1 })
      .then(url => { if (!cancelled && mounted.current) setQrDataUrl(url) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [savedHandle])

  /* ── private pay-link token ───────────────────────────────────────── */
  // Null covers both "privacy not enabled" and "lookup failed": PayLinks then
  // shows the normal link alone, which is accurate either way, rather than
  // rendering a private link that would not resolve.
  useEffect(() => {
    if (!address) { setPayLinkToken(null); return }
    let cancelled = false
    fetch(`/api/stealth/${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { data?: { linkToken: string | null } } | null) => {
        if (!cancelled && mounted.current) setPayLinkToken(body?.data?.linkToken ?? null)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address])

  /* ── handlers ─────────────────────────────────────────────────────── */
  function changeHandle(raw: string) {
    setHandleInput(raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20))
    setError(null)
  }

  function cancelEdit() {
    setHandleInput(savedHandle ?? '')
    setError(null)
    setEditingHandle(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!address || availability !== 'available') return
    const handle = handleInput.trim()
    if (handle === savedHandle) { setEditingHandle(false); return }
    setError(null)
    setSaving(true)
    try {
      const message   = `Split: claim @${handle} for ${address.toLowerCase()}`
      const signature = await signMessageAsync({ message })
      const r    = await fetch('/api/profile', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ address, handle, signature }),
      })
      const body = await r.json() as { error?: string }
      if (!r.ok) throw new Error(body.error ?? 'Save failed')
      if (mounted.current) {
        setSavedHandle(handle)
        setEditingHandle(false)
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Failed to save handle')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !address) return
    setError(null)
    if (!(ALLOWED_TYPES as readonly string[]).includes(file.type)) {
      setError('Only JPEG, PNG, or WebP avatars are supported.')
      return
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError('Avatar must be under 1 MB.')
      return
    }
    setUploading(true)
    try {
      const message   = `Split: update avatar for ${address.toLowerCase()}`
      const signature = await signMessageAsync({ message })
      const fd = new FormData()
      fd.append('file', file)
      fd.append('address', address)
      fd.append('signature', signature)
      const r    = await fetch('/api/profile/avatar', { method: 'POST', body: fd })
      const body = await r.json() as { avatar_url?: string; error?: string }
      if (!r.ok) throw new Error(body.error ?? 'Upload failed')
      if (mounted.current && body.avatar_url) setAvatarUrl(body.avatar_url)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      if (mounted.current) setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function copyShareLink() {
    if (!savedHandle) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/pay/${savedHandle}`)
      setCopiedLink(true)
      setTimeout(() => { if (mounted.current) setCopiedLink(false) }, 2_000)
    } catch { /* clipboard unavailable */ }
  }

  function shareTwitter() {
    if (!savedHandle) return
    const text = encodeURIComponent(`Pay me USDC directly: ${window.location.origin}/pay/${savedHandle}`)
    window.open(`https://twitter.com/intent/tweet?text=${text}`, '_blank', 'noopener,noreferrer')
  }

  function shareWhatsApp() {
    if (!savedHandle) return
    const text = encodeURIComponent(`Pay me at ${window.location.origin}/pay/${savedHandle}`)
    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener,noreferrer')
  }

  function shareInstagram() {
    if (!savedHandle) return
    navigator.clipboard
      .writeText(`${window.location.origin}/pay/${savedHandle}`)
      .then(() => {
        setIgCopied(true)
        setTimeout(() => { if (mounted.current) setIgCopied(false) }, 2_000)
      })
      .catch(() => {})
  }

  function shareGeneric() {
    if (!savedHandle) return
    const url = `${window.location.origin}/pay/${savedHandle}`
    if (typeof navigator.share === 'function') {
      navigator.share({ title: 'Pay me on Split', url }).catch(() => {})
    } else {
      navigator.clipboard.writeText(url).catch(() => {})
    }
  }

  /* ── guard ────────────────────────────────────────────────────────── */
  if (!address) return null

  const avatarInitial = savedHandle
    ? (savedHandle[0]?.toUpperCase() ?? '?')
    : (address[2]?.toUpperCase() ?? '?')

  return (
    <div className="pr-page">
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={handleAvatarChange}
        aria-hidden="true"
        tabIndex={-1}
      />

      <h1 className="sr-only">Profile</h1>

      {/* Identity block: centered, avatar is the focal point. Avatar upload is
          always available; handle editing collapses to a click-to-edit label
          once a handle exists, so the page reads as pay-links-first. */}
      <div className="pr-identity">
        <button
          type="button"
          className="pr-avatar-btn"
          onClick={() => fileRef.current?.click()}
          aria-label={avatarUrl ? 'Change avatar' : 'Add an avatar'}
        >
          {avatarUrl ? (
            <Image src={avatarUrl} alt="" fill sizes="144px" className="object-cover" />
          ) : (
            <span aria-hidden="true">{avatarInitial}</span>
          )}
          <span className="pr-avatar-overlay" aria-hidden="true">
            <Camera size={22} color="white" />
          </span>
          <span className="pr-avatar-pencil" aria-hidden="true">
            <SquarePen size={16} />
          </span>
          {uploading && (
            <span className="pr-avatar-spinner" aria-hidden="true">
              <span className="pr-spin-ring" />
            </span>
          )}
        </button>

        {!showForm && savedHandle ? (
          <button
            type="button"
            className="pr-identity-handle-btn"
            onClick={() => setEditingHandle(true)}
            aria-label={`Edit handle, currently @${savedHandle}`}
          >
            @{savedHandle}
          </button>
        ) : (
          <p className="pr-identity-hint">Claim a handle so people can pay you by name.</p>
        )}
      </div>

      {showForm && (
        <form onSubmit={(e) => void handleSave(e)} noValidate className="pr-form-wrap">
          <input
            id="pr-handle-inp"
            type="text"
            className={`pr-handle-solo ${
              availability === 'available' ? 'pr-handle-ok'
              : availability === 'taken' || availability === 'invalid' ? 'pr-handle-err'
              : ''
            }`}
            placeholder="your-handle"
            value={handleInput}
            onChange={(e) => changeHandle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelEdit() } }}
            onBlur={() => { if (savedHandle && !saving) cancelEdit() }}
            maxLength={20}
            autoComplete="off"
            spellCheck={false}
            autoFocus={editingHandle}
            disabled={saving}
            aria-label="Handle"
          />
          {availability === 'taken' && <p className="pr-form-error">That handle is taken.</p>}
          {availability === 'invalid' && <p className="pr-form-error">3-20 characters: letters, numbers, - or _.</p>}
          {error && <p className="pr-form-error" role="alert">{error}</p>}
        </form>
      )}

      {savedHandle && (
        <div className="pr-content">
          {/* Pay links are the reason this page exists, so they lead, full width,
              at the top of the primary column. It's the only side that scrolls
              internally if it ever outgrows the share/QR column's height. */}
          <div className="pr-links-col">
            <PayLinks handle={savedHandle} linkToken={payLinkToken} />
          </div>

          <div className="pr-side">
            <div className="pr-card">
              <h2 className="pr-card-title">Share</h2>
              <div className="pr-share-code">
                <p className="pr-share-code-text">
                  Drop USDC directly to my Split address on Arc Testnet: split.app/pay/{savedHandle}
                </p>
                <button
                  type="button"
                  className="pr-share-copy-btn"
                  onClick={() => void copyShareLink()}
                  aria-label="Copy share message"
                >
                  {copiedLink
                    ? <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>✓</span>
                    : <Copy size={14} />
                  }
                </button>
              </div>
              <div className="pr-social-row">
                <button type="button" className="pr-social-btn" data-p="twitter" onClick={shareTwitter} aria-label="Share on X (Twitter)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#1DA1F2" aria-hidden="true">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.742l7.727-8.83-8.16-10.671h7.137l4.26 5.633zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                  </svg>
                </button>
                <button type="button" className="pr-social-btn" data-p="whatsapp" onClick={shareWhatsApp} aria-label="Share on WhatsApp">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </button>
                <button type="button" className="pr-social-btn" data-p="instagram" onClick={shareInstagram} aria-label="Copy link for Instagram">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#E1306C" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
                    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
                    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
                  </svg>
                  {igCopied && <span className="pr-social-toast">Link copied!</span>}
                </button>
                <button type="button" className="pr-social-btn" data-p="share" onClick={shareGeneric} aria-label="Share">
                  <Share2 size={17} color="var(--accent)" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="pr-card">
              <h2 className="pr-card-title">QR code</h2>
              <button
                type="button"
                className="pr-qr-btn"
                onClick={() => setQrModalOpen(true)}
                aria-label="View, download, or share your QR code"
              >
                <span className="pr-qr-img-wrap">
                  {qrDataUrl ? (
                    <Image src={qrDataUrl} alt="" width={140} height={140} unoptimized />
                  ) : (
                    <span className="pr-qr-skel" aria-hidden="true" />
                  )}
                </span>
              </button>
              <p className="pr-qr-caption">
                <QrCode size={13} aria-hidden="true" /> Tap to view, download, or share
              </p>
            </div>
          </div>
        </div>
      )}

      {qrModalOpen && savedHandle && (
        <QrModal handle={savedHandle} onClose={() => setQrModalOpen(false)} />
      )}
    </div>
  )
}
