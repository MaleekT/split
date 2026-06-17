'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { useAccount, useSignMessage } from 'wagmi'
import { isValidHandle } from '@/lib/handle'
import { Camera, Copy, Download, Share2, X as XIcon } from 'lucide-react'
import QRCode from 'qrcode'

type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'invalid'

const MAX_AVATAR_BYTES = 1_048_576
const ALLOWED_TYPES    = ['image/jpeg', 'image/png', 'image/webp'] as const

/* ── Page-scoped CSS ────────────────────────────────────────────────────── */
const PAGE_CSS = `
:root {
  --pr-glass:      rgba(255,255,255,0.60);
  --pr-glass-card: rgba(244,242,238,0.65);
}
.dark {
  --pr-glass:      rgba(21,21,28,0.55);
  --pr-glass-card: rgba(11,11,15,0.60);
}

@keyframes pr-spin { to { transform:rotate(360deg); } }

/* ── Page wrapper ── */
.pr-page {
  display:flex;
  flex-direction:column;
  height:calc(100vh - 48px);
}

/* ── Page header (full-width, above grid) ── */
.pr-header {
  display:flex; align-items:center; justify-content:space-between;
  margin-bottom:24px; flex-shrink:0;
}
.pr-header-title { font-size:20px; font-weight:700; letter-spacing:-0.025em; color:var(--text); }
.pr-handle-badge {
  display:inline-flex; align-items:center; gap:6px;
  background:var(--bg-3); border:0.5px solid var(--border);
  border-radius:999px; padding:3px 10px 3px 3px;
  font-size:13px; color:var(--text-2); font-weight:500;
}
.pr-badge-dot {
  width:22px; height:22px; border-radius:50%; flex-shrink:0;
  background:linear-gradient(135deg, var(--accent), #60A5FA);
  display:flex; align-items:center; justify-content:center;
  font-size:11px; font-weight:700; color:#fff; user-select:none;
}

/* ── Shell ── */
.pr-shell {
  display:grid;
  grid-template-columns:3fr 2fr;
  gap:24px;
  align-items:stretch;
  max-width:960px;
  flex:1;
  min-height:0;
}
.pr-left  { display:flex; flex-direction:column; gap:18px; }
.pr-right { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; }

/* ── Identity card ── */
.pr-id-card {
  position:relative; border-radius:16px; height:180px; width:100%;
  overflow:hidden; display:flex; align-items:center; justify-content:center;
  background:var(--bg-2); border:0.5px solid var(--border);
  box-shadow:0 0 0 0.5px var(--border), 0 8px 32px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.08);
  cursor:pointer; transition:box-shadow 0.2s;
}
@supports (backdrop-filter:blur(1px)) {
  .pr-id-card {
    background:var(--pr-glass);
    backdrop-filter:blur(20px);
    -webkit-backdrop-filter:blur(20px);
  }
}
.pr-id-card:hover {
  box-shadow:0 0 0 1px var(--accent), 0 8px 32px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.12);
}
.pr-id-card:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.pr-hover-badge {
  position:absolute; top:12px; right:12px;
  font-size:11px; font-weight:500;
  background:var(--accent-bg); color:var(--accent);
  padding:2px 8px; border-radius:999px;
  opacity:0; transition:opacity 0.2s; pointer-events:none;
}
.pr-id-card:hover .pr-hover-badge { opacity:1; }
.pr-id-avatar {
  width:96px; height:96px; border-radius:50%; overflow:hidden; position:relative;
  background:linear-gradient(135deg, var(--accent), #60A5FA);
  display:flex; align-items:center; justify-content:center;
  font-size:32px; font-weight:700; color:#fff; flex-shrink:0;
  box-shadow:0 4px 20px rgba(0,0,0,0.25); z-index:1;
}
.pr-id-overlay {
  position:absolute; inset:0; z-index:2;
  background:rgba(0,0,0,0.52);
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px;
  opacity:0; transition:opacity 0.2s;
}
.pr-id-card:hover .pr-id-overlay { opacity:1; }
.pr-id-overlay-text { font-size:13px; color:rgba(255,255,255,0.9); font-weight:500; }
.pr-id-spinner {
  position:absolute; inset:0; z-index:3;
  background:rgba(0,0,0,0.5);
  display:flex; align-items:center; justify-content:center;
}
.pr-spin-ring {
  width:24px; height:24px; border-radius:50%;
  border:2px solid rgba(255,255,255,0.25); border-top-color:#fff;
  animation:pr-spin 0.7s linear infinite;
}

/* ── Handle form ── */
.pr-form-label {
  display:block; font-size:11px; font-weight:600; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--text-3); margin-bottom:6px;
}
.pr-handle-row { display:flex; align-items:center; gap:8px; }
.pr-handle-input-wrap { position:relative; flex:1; }
.pr-handle-at {
  position:absolute; left:12px; top:50%; transform:translateY(-50%);
  font-size:14px; font-family:var(--font-jetbrains-mono,monospace);
  color:var(--text-3); pointer-events:none;
}
.pr-handle-input {
  width:100%; padding:10px 12px 10px 26px;
  border:0.5px solid var(--border); border-radius:10px;
  background:var(--bg-2); color:var(--text); font-size:14px;
  font-family:var(--font-jetbrains-mono,monospace);
  outline:none; transition:border-color 0.15s;
}
.pr-handle-input:focus { border-color:var(--accent); }
.pr-handle-input::placeholder { color:var(--text-3); }
.pr-avail-pill {
  font-size:12px; font-weight:500; padding:4px 10px; border-radius:999px;
  white-space:nowrap; flex-shrink:0;
}
.pr-avail-ok   { background:var(--accent-bg); color:var(--accent); }
.pr-avail-err  { background:rgba(239,68,68,0.10); color:#EF4444; }
.pr-avail-warn { background:rgba(245,158,11,0.10); color:#F59E0B; }
.pr-avail-dim  { background:var(--bg-3); color:var(--text-3); }
.pr-form-error { font-size:12px; color:#EF4444; margin-top:6px; }
.pr-save-btn {
  width:100%; padding:11px; border-radius:10px; border:none;
  background:linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%); color:#fff; font-size:14px; font-weight:600;
  cursor:pointer; transition:opacity 0.15s; margin-top:10px; font-family:inherit;
}
.pr-save-btn:hover:not(:disabled) { opacity:0.85; }
.pr-save-btn:disabled { opacity:0.38; cursor:not-allowed; }

/* ── Share link box ── */
.pr-share-header { display:flex; align-items:center; justify-content:space-between; }
.pr-share-label {
  font-size:11px; font-weight:600; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--text-3);
}
.pr-share-close {
  background:none; border:none; cursor:pointer; color:var(--text-3);
  padding:2px; display:flex; align-items:center; transition:color 0.15s;
}
.pr-share-close:hover { color:var(--text); }
.pr-share-code {
  display:flex; align-items:flex-start; gap:12px;
  background:rgba(0,0,0,0.08); border:0.5px solid var(--border);
  border-radius:10px; padding:14px 16px; margin-top:8px;
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
.pr-share-copy-btn:hover { color:var(--accent); border-color:var(--accent); }

/* ── Social blast matrix ── */
.pr-social-label {
  font-size:11px; font-weight:600; text-transform:uppercase;
  letter-spacing:0.06em; color:var(--text-3); margin-bottom:10px;
}
.pr-social-row { display:flex; gap:12px; align-items:center; padding-bottom:8px; }
.pr-social-btn {
  width:56px; height:56px; border-radius:50%;
  border:0.5px solid var(--border); background:var(--bg-2);
  display:flex; align-items:center; justify-content:center;
  cursor:pointer; position:relative; flex-shrink:0;
  transition:transform 0.2s, box-shadow 0.2s;
}
.pr-social-btn:hover { transform:translateY(-2px); }
.pr-social-btn[data-p="twitter"]:hover   { box-shadow:0 0 0 2px #1DA1F2, 0 4px 16px rgba(29,161,242,0.30); }
.pr-social-btn[data-p="whatsapp"]:hover  { box-shadow:0 0 0 2px #25D366, 0 4px 16px rgba(37,211,102,0.30); }
.pr-social-btn[data-p="instagram"]:hover { box-shadow:0 0 0 2px #E1306C, 0 4px 16px rgba(225,48,108,0.30); }
.pr-social-btn[data-p="share"]:hover     { box-shadow:0 0 0 2px var(--accent), 0 4px 16px rgba(29,158,117,0.30); }
.pr-social-toast {
  position:absolute; bottom:-22px; left:50%; transform:translateX(-50%);
  font-size:10px; font-weight:500; white-space:nowrap; color:var(--accent);
  pointer-events:none;
}

/* ── Browser inner top bar (Live Preview label) ── */
.pr-browser-topbar {
  display:flex; align-items:center; justify-content:space-between;
  padding:12px 14px 10px; border-bottom:0.5px solid var(--border); flex-shrink:0;
}
.pr-right-label {
  font-size:11px; font-weight:700; text-transform:uppercase;
  letter-spacing:0.10em; color:var(--text-3);
}
.pr-public-badge {
  font-size:11px; font-weight:500; color:var(--accent);
  background:var(--accent-bg); border-radius:999px; padding:2px 8px;
}

/* ── Mock browser ── */
.pr-browser {
  border-radius:16px; overflow:hidden; border:0.5px solid var(--border);
  background:var(--bg-2);
  box-shadow:0 0 0 0.5px var(--border), 0 16px 48px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.06);
  flex:1; min-height:0; display:flex; flex-direction:column;
}
@supports (backdrop-filter:blur(1px)) {
  .pr-browser {
    background:var(--pr-glass);
    backdrop-filter:blur(24px);
    -webkit-backdrop-filter:blur(24px);
  }
}
.pr-browser-chrome {
  padding:10px 14px 10px; border-bottom:0.5px solid var(--border);
  display:flex; align-items:center; gap:10px; flex-shrink:0;
}
.pr-browser-tl { display:flex; gap:6px; flex-shrink:0; align-items:center; }
.pr-browser-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
.pr-browser-url {
  flex:1; font-size:11px; font-family:var(--font-jetbrains-mono,monospace);
  color:var(--text-3); background:rgba(0,0,0,0.08); border-radius:6px;
  padding:4px 10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.dark .pr-browser-url { background:rgba(255,255,255,0.06); }

/* ── Mini pay content ── */
.pr-mini-pay {
  padding:20px 16px 24px; display:flex; flex-direction:column;
  align-items:center; gap:10px; text-align:center;
  flex:1; justify-content:center;
}
.pr-mini-avatar {
  width:44px; height:44px; border-radius:50%; overflow:hidden; position:relative;
  background:linear-gradient(135deg, var(--accent), #60A5FA);
  display:flex; align-items:center; justify-content:center;
  font-size:18px; font-weight:700; color:#fff; flex-shrink:0;
}
.pr-mini-handle { font-size:14px; font-weight:600; color:var(--text); }
.pr-mini-subtext { font-size:11px; color:var(--text-3); margin-top:-4px; }
.pr-mini-amount-row {
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  width:100%; padding:8px 14px; background:var(--bg-3); border-radius:10px;
}
.pr-mini-amount {
  font-size:18px; font-weight:700;
  font-family:var(--font-jetbrains-mono,monospace); color:var(--text);
}
.pr-mini-currency { font-size:12px; color:var(--text-3); font-weight:500; }
.pr-mini-pay-btn {
  width:100%; padding:10px; border-radius:10px; border:none;
  background:linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%); color:#fff; font-size:13px; font-weight:600;
  cursor:default; font-family:inherit; opacity:0.85;
}

/* ── Action drawer ── */
.pr-action-drawer { display:flex; flex-direction:column; gap:8px; }
.pr-action-row {
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  width:100%; padding:12px 16px; background:var(--bg-2); border:0.5px solid var(--border);
  border-radius:12px; cursor:pointer; transition:background 0.15s;
  font-family:inherit; text-align:left;
}
.pr-action-row:hover:not(:disabled) { background:var(--bg-3); }
.pr-action-row:disabled { cursor:not-allowed; opacity:0.5; }
.pr-action-left {
  display:flex; align-items:center; gap:10px;
  font-size:13px; font-weight:500; color:var(--text);
}
.pr-action-right { display:flex; align-items:center; gap:8px; flex-shrink:0; }
.pr-copied-text { font-size:12px; color:var(--accent); font-weight:500; white-space:nowrap; }
.pr-qr-thumb { width:32px; height:32px; border-radius:4px; display:block; }

/* ── Right footer ── */
.pr-col-footer {
  display:flex; align-items:center; justify-content:space-between;
  padding-top:4px;
}
.pr-footer-left { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-3); }
.pr-footer-dot  { width:7px; height:7px; border-radius:50%; background:var(--accent); flex-shrink:0; }
.pr-footer-right { font-size:11px; color:var(--text-3); }

/* ── Responsive ── */
@media (max-width:768px) {
  .pr-shell { grid-template-columns:1fr; }
}
`

export default function ProfilePage() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  /* ── refs ─────────────────────────────────────────────────────────── */
  const mounted       = useRef(false)
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileRef       = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (debounceRef.current)   clearTimeout(debounceRef.current)
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      if (copyTimerRef.current)  clearTimeout(copyTimerRef.current)
    }
  }, [])

  /* ── existing state ───────────────────────────────────────────────── */
  const [savedHandle,  setSavedHandle]  = useState<string | null>(null)
  const [avatarUrl,    setAvatarUrl]    = useState<string | null>(null)
  const [handleInput,  setHandleInput]  = useState('')
  const [availability, setAvailability] = useState<Availability>('idle')
  const [saving,    setSaving]    = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [saved,     setSaved]     = useState(false)
  const [copied,    setCopied]    = useState(false)

  /* ── new state ────────────────────────────────────────────────────── */
  const [showShareLink, setShowShareLink] = useState(true)
  const [copiedLink,    setCopiedLink]    = useState(false)
  const [igCopied,      setIgCopied]      = useState(false)
  const [qrDataUrl,     setQrDataUrl]     = useState<string | null>(null)

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

  /* ── existing handlers ────────────────────────────────────────────── */
  function changeHandle(raw: string) {
    setHandleInput(raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20))
    setSaved(false)
    setError(null)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!address || availability !== 'available') return
    const handle = handleInput.trim()
    if (handle === savedHandle) return
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
        setSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => {
          if (mounted.current) setSaved(false)
        }, 3_000)
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

  async function copyPayLink() {
    if (!savedHandle) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/pay/${savedHandle}`)
      setCopied(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => { if (mounted.current) setCopied(false) }, 2_000)
    } catch { /* clipboard unavailable */ }
  }

  /* ── new handlers ─────────────────────────────────────────────────── */
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

  function downloadQr() {
    if (!qrDataUrl || !savedHandle) return
    const a = document.createElement('a')
    a.href = qrDataUrl
    a.download = `split-${savedHandle}-qr.png`
    a.click()
  }

  /* ── guard ────────────────────────────────────────────────────────── */
  if (!address) return null

  const canSave       = availability === 'available' && handleInput.trim() !== savedHandle && !saving
  const avatarInitial = savedHandle
    ? (savedHandle[0]?.toUpperCase() ?? '?')
    : (address[2]?.toUpperCase() ?? '?')

  const previewHandle  = handleInput || 'yourhandle'
  const previewInitial = (handleInput[0] ?? 'y').toUpperCase()

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

      {/* Full-width page header — badge top-right above live preview */}
      <div className="pr-header">
        <h1 className="pr-header-title">Profile</h1>
        {savedHandle && (
          <div className="pr-handle-badge">
            <span className="pr-badge-dot" aria-hidden="true">{avatarInitial}</span>
            @{savedHandle}
          </div>
        )}
      </div>

      <div className="pr-shell">

        {/* ══════════════ LEFT COLUMN ══════════════ */}
        <div className="pr-left">

          {/* Identity Card */}
          <div
            className="pr-id-card"
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Click to upload avatar"
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
          >
            <span className="pr-hover-badge" aria-hidden="true">Hover active</span>

            <div className="pr-id-overlay" aria-hidden="true">
              <Camera size={24} color="white" />
              <span className="pr-id-overlay-text">Upload PNG or JPEG</span>
            </div>

            {uploading && (
              <div className="pr-id-spinner" aria-hidden="true">
                <div className="pr-spin-ring" />
              </div>
            )}

            <div className="pr-id-avatar">
              {avatarUrl ? (
                <Image src={avatarUrl} alt="Your avatar" fill sizes="96px" className="object-cover" />
              ) : (
                <span aria-hidden="true">{avatarInitial}</span>
              )}
            </div>
          </div>

          {/* Handle form */}
          <form onSubmit={(e) => void handleSave(e)} noValidate>
            <label className="pr-form-label" htmlFor="pr-handle-inp">Handle</label>
            <div className="pr-handle-row">
              <div className="pr-handle-input-wrap">
                <span className="pr-handle-at" aria-hidden="true">@</span>
                <input
                  id="pr-handle-inp"
                  type="text"
                  className="pr-handle-input"
                  placeholder="your-handle"
                  value={handleInput}
                  onChange={(e) => changeHandle(e.target.value)}
                  maxLength={20}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {availability !== 'idle' && handleInput.trim() && (
                <span className={`pr-avail-pill ${
                  availability === 'available' ? 'pr-avail-ok'
                  : availability === 'taken'   ? 'pr-avail-err'
                  : availability === 'invalid' ? 'pr-avail-warn'
                  : 'pr-avail-dim'
                }`}>
                  {availability === 'available' ? '✓ available'
                  : availability === 'taken'    ? '✗ taken'
                  : availability === 'invalid'  ? 'invalid'
                  : 'checking…'}
                </span>
              )}
            </div>
            {error && <p className="pr-form-error" role="alert">{error}</p>}
            <button type="submit" className="pr-save-btn" disabled={!canSave}>
              {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save handle'}
            </button>
          </form>

          {/* Share Link Box */}
          {savedHandle && showShareLink && (
            <div>
              <div className="pr-share-header">
                <span className="pr-share-label">Share Link</span>
                <button
                  type="button"
                  className="pr-share-close"
                  onClick={() => setShowShareLink(false)}
                  aria-label="Dismiss share link"
                >
                  <XIcon size={14} />
                </button>
              </div>
              <div className="pr-share-code">
                <p className="pr-share-code-text">
                  Drop USDC directly to my Split address on Arc Testnet: split.app/pay/{savedHandle} ⚡
                </p>
                <button
                  type="button"
                  className="pr-share-copy-btn"
                  onClick={() => void copyShareLink()}
                  aria-label="Copy share link"
                >
                  {copiedLink
                    ? <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>✓</span>
                    : <Copy size={14} />
                  }
                </button>
              </div>
            </div>
          )}

          {/* Social Blast Matrix */}
          {savedHandle && (
            <div>
              <p className="pr-social-label">Share via</p>
              <div className="pr-social-row">

                <button type="button" className="pr-social-btn" data-p="twitter" onClick={shareTwitter} aria-label="Share on X (Twitter)">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="#1DA1F2" aria-hidden="true">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.742l7.727-8.83-8.16-10.671h7.137l4.26 5.633zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                  </svg>
                </button>

                <button type="button" className="pr-social-btn" data-p="whatsapp" onClick={shareWhatsApp} aria-label="Share on WhatsApp">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#25D366" aria-hidden="true">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </button>

                <button type="button" className="pr-social-btn" data-p="instagram" onClick={shareInstagram} aria-label="Copy link for Instagram">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E1306C" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
                    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
                    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
                  </svg>
                  {igCopied && <span className="pr-social-toast">Link copied!</span>}
                </button>

                <button type="button" className="pr-social-btn" data-p="share" onClick={shareGeneric} aria-label="Share">
                  <Share2 size={20} color="var(--accent)" aria-hidden="true" />
                </button>

              </div>
            </div>
          )}

        </div>

        {/* ══════════════ RIGHT COLUMN ══════════════ */}
        <div className="pr-right">

          {/* Mock Browser */}
          <div className="pr-browser">
            <div className="pr-browser-topbar">
              <span className="pr-right-label">Live Preview</span>
              <span className="pr-public-badge">[Public]</span>
            </div>
            <div className="pr-browser-chrome">
              <div className="pr-browser-tl" aria-hidden="true">
                <span className="pr-browser-dot" style={{ background: '#FF5F57' }} />
                <span className="pr-browser-dot" style={{ background: '#FEBC2E' }} />
                <span className="pr-browser-dot" style={{ background: '#28C840' }} />
              </div>
              <span className="pr-browser-url">
                split.app/pay/{previewHandle}
              </span>
            </div>

            <div className="pr-mini-pay">
              <div className="pr-mini-avatar" aria-hidden="true">
                {avatarUrl ? (
                  <Image src={avatarUrl} alt="" fill sizes="44px" className="object-cover" />
                ) : (
                  <span>{previewInitial}</span>
                )}
              </div>
              <div>
                <p className="pr-mini-handle">@{previewHandle}</p>
                <p className="pr-mini-subtext">Pay me in USDC on Arc Testnet</p>
              </div>
              <div className="pr-mini-amount-row" aria-hidden="true">
                <span className="pr-mini-amount">[ 0.00 ]</span>
                <span className="pr-mini-currency">USDC</span>
              </div>
              <button className="pr-mini-pay-btn" type="button" disabled tabIndex={-1} aria-hidden="true">
                Pay Invoice
              </button>
            </div>
          </div>

          {/* Action Drawer */}
          {savedHandle && (
            <div className="pr-action-drawer">
              <button type="button" className="pr-action-row" onClick={() => void copyPayLink()}>
                <span className="pr-action-left">
                  <Copy size={15} color="var(--text-2)" aria-hidden="true" />
                  Copy Link
                </span>
                <span className="pr-action-right">
                  {copied && <span className="pr-copied-text">✓ Copied!</span>}
                </span>
              </button>

              <button
                type="button"
                className="pr-action-row"
                onClick={downloadQr}
                disabled={!qrDataUrl}
              >
                <span className="pr-action-left">
                  <Download size={15} color="var(--text-2)" aria-hidden="true" />
                  Download QR Code
                </span>
                <span className="pr-action-right">
                  {qrDataUrl && (
                    <Image
                      src={qrDataUrl}
                      alt="QR code preview"
                      width={32}
                      height={32}
                      unoptimized
                      className="pr-qr-thumb"
                    />
                  )}
                </span>
              </button>
            </div>
          )}

          {/* Right footer */}
          <div className="pr-col-footer">
            <span className="pr-footer-left">
              <span className="pr-footer-dot" aria-hidden="true" />
              Systems operational
            </span>
            <span className="pr-footer-right">Subtly polished</span>
          </div>

        </div>
      </div>
    </div>
  )
}
