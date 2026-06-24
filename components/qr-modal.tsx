'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import QRCode from 'qrcode'
import { Download, Share2, Copy, Camera, X as XIcon } from 'lucide-react'
import type QrScanner from 'qr-scanner'

interface QrModalProps {
  handle:  string
  onClose: () => void
}

type Tab       = 'mine' | 'scan'
type ScanState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unsupported' | 'redirecting'

const PAY_PATH = /^\/pay\/([a-z0-9_-]{1,20})$/i

/** Returns the handle if `text` is a Split pay link, else null. */
function extractHandle(text: string): string | null {
  try {
    const match = new URL(text).pathname.match(PAY_PATH)
    return match ? match[1]! : null
  } catch {
    return null
  }
}

const QR_PX = 232

export function QrModal({ handle, onClose }: QrModalProps) {
  const router  = useRouter()
  const payUrl  = `https://split.app/pay/${handle}`

  const modalRef   = useRef<HTMLDivElement>(null)
  const videoRef   = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const mounted    = useRef(true)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  const [qrUrl,      setQrUrl]      = useState<string | null>(null)
  const [tab,        setTab]        = useState<Tab>('mine')
  const [isMobile,   setIsMobile]   = useState(false)
  const [scanState,  setScanState]  = useState<ScanState>('idle')
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [copied,     setCopied]     = useState(false)

  /* ── hi-res QR for display / download / share ─────────────────────── */
  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(payUrl, { width: 1024, margin: 2 })
      .then((url) => { if (!cancelled && mounted.current) setQrUrl(url) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [payUrl])

  /* ── mobile detection (after mount → no SSR mismatch) ─────────────── */
  useEffect(() => {
    const coarse = window.matchMedia('(pointer: coarse)').matches
    const hasCam = !!navigator.mediaDevices?.getUserMedia
    setIsMobile(coarse && hasCam)
  }, [])

  /* ── camera lifecycle ─────────────────────────────────────────────── */
  const stopScanner = useCallback(() => {
    const scanner = scannerRef.current
    if (!scanner) return
    try { scanner.stop() } catch {}
    try { scanner.destroy() } catch {}
    scannerRef.current = null
  }, [])

  const startScanning = useCallback(async () => {
    if (scannerRef.current || !videoRef.current) return
    setScanResult(null)
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setScanState('unsupported')
      return
    }
    setScanState('starting')
    try {
      const { default: QrScannerCtor } = await import('qr-scanner')
      if (!mounted.current || !videoRef.current) return
      const scanner = new QrScannerCtor(
        videoRef.current,
        (result: { data: string }) => {
          const scanned = extractHandle(result.data)
          if (scanned) {
            setScanState('redirecting')
            stopScanner()
            router.push(`/pay/${scanned}`)
          } else {
            setScanResult(result.data)
          }
        },
        { preferredCamera: 'environment', highlightScanRegion: true, highlightCodeOutline: true, maxScansPerSecond: 5 },
      )
      scannerRef.current = scanner
      await scanner.start()
      if (!mounted.current) { stopScanner(); return }
      setScanState('scanning')
    } catch (err) {
      stopScanner()
      const name = (err as { name?: string })?.name
      setScanState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unsupported')
    }
  }, [router, stopScanner])

  useEffect(() => {
    if (tab === 'scan') void startScanning()
    else { stopScanner(); setScanState('idle') }
  }, [tab, startScanning, stopScanner])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stopScanner() }
  }, [stopScanner])

  /* ── scroll lock ──────────────────────────────────────────────────── */
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  /* ── focus dialog + Escape + focus trap ───────────────────────────── */
  useEffect(() => { modalRef.current?.focus() }, [])
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key !== 'Tab' || !modalRef.current) return
      const els = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])'),
      )
      if (els.length === 0) return
      const first = els[0]!
      const last  = els[els.length - 1]!
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault() }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  /* ── actions ──────────────────────────────────────────────────────── */
  function downloadQr() {
    if (!qrUrl) return
    const a = document.createElement('a')
    a.href = qrUrl
    a.download = `split-${handle}-qr.png`
    a.click()
  }

  async function shareQr() {
    try {
      if (qrUrl && typeof navigator.canShare === 'function') {
        const blob = await (await fetch(qrUrl)).blob()
        const file = new File([blob], `split-${handle}-qr.png`, { type: 'image/png' })
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: 'My Split QR', text: `Pay me on Split: ${payUrl}` })
          return
        }
      }
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Pay me on Split', url: payUrl })
        return
      }
      downloadQr()
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') downloadQr()
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(payUrl)
      setCopied(true)
      setTimeout(() => { if (mounted.current) setCopied(false) }, 2_000)
    } catch {}
  }

  /* ── styles ───────────────────────────────────────────────────────── */
  const actionBtn = 'inline-flex flex-1 items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition disabled:opacity-40'
  const ghostBtn  = `${actionBtn} border border-[var(--split-border)] text-[var(--split-text-primary)] hover:bg-[var(--split-bg-secondary)]`
  const solidBtn  = `${actionBtn} font-semibold text-white bg-[var(--split-accent)] hover:opacity-85`
  const tabBtn    = (active: boolean) =>
    `flex-1 rounded-lg py-2 text-sm font-medium transition ${
      active
        ? 'bg-[var(--split-bg-primary)] text-[var(--split-text-primary)] shadow-sm'
        : 'text-[var(--split-text-secondary)] hover:text-[var(--split-text-primary)]'
    }`

  const heading  = tab === 'scan' ? 'Scan a code' : 'Your Split QR'
  const subtitle = tab === 'scan' ? 'Point your camera at a Split QR code' : 'Let others scan this to pay you'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-modal-title"
    >
      <style>{`
        @keyframes qrm-in { from { opacity:0; transform:translateY(8px) scale(0.97); } to { opacity:1; transform:none; } }
        .qrm-card { animation: qrm-in 0.22s cubic-bezier(0.16,1,0.3,1); }
        @media (prefers-reduced-motion: reduce) { .qrm-card { animation: none; } }
      `}</style>

      <div aria-hidden="true" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />

      <div
        ref={modalRef}
        tabIndex={-1}
        className="qrm-card relative w-full max-w-sm rounded-2xl bg-[var(--split-bg-primary)] shadow-2xl p-6 space-y-5 outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg text-[var(--split-text-secondary)] hover:bg-[var(--split-bg-secondary)] hover:text-[var(--split-text-primary)] transition"
        >
          <XIcon size={18} />
        </button>

        <div>
          <h2 id="qr-modal-title" className="text-base font-semibold text-[var(--split-text-primary)]">{heading}</h2>
          <p className="text-sm text-[var(--split-text-secondary)] mt-0.5">{subtitle}</p>
        </div>

        {isMobile && (
          <div className="flex gap-1 rounded-xl bg-[var(--split-bg-secondary)] p-1">
            <button type="button" className={tabBtn(tab === 'mine')} onClick={() => setTab('mine')}>My QR</button>
            <button type="button" className={tabBtn(tab === 'scan')} onClick={() => setTab('scan')}>Scan</button>
          </div>
        )}

        {tab === 'mine' ? (
          <div className="space-y-5">
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-2xl bg-white p-4 shadow-sm">
                {qrUrl ? (
                  <Image
                    src={qrUrl}
                    alt={`Split pay QR code for @${handle}`}
                    width={QR_PX}
                    height={QR_PX}
                    unoptimized
                    className="block"
                  />
                ) : (
                  <div className="animate-pulse rounded-lg bg-[var(--split-bg-secondary)]" style={{ width: QR_PX, height: QR_PX }} />
                )}
              </div>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="inline-flex items-center gap-1.5 text-xs text-[var(--split-text-tertiary)] hover:text-[var(--split-accent)] transition"
              >
                <Copy size={13} />
                {copied ? 'Copied!' : `split.app/pay/${handle}`}
              </button>
            </div>

            <div className="flex gap-3">
              <button type="button" className={ghostBtn} onClick={downloadQr} disabled={!qrUrl}>
                <Download size={16} /> Download
              </button>
              <button type="button" className={solidBtn} onClick={() => void shareQr()} disabled={!qrUrl}>
                <Share2 size={16} /> Share
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />

              {scanState === 'scanning' && (
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid place-items-center">
                  <div className="h-44 w-44 rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
                </div>
              )}

              {scanState !== 'scanning' && (
                <div className="absolute inset-0 grid place-items-center bg-[var(--split-bg-primary)]/95 p-6 text-center">
                  <div className="space-y-2">
                    <Camera size={26} className="mx-auto text-[var(--split-text-tertiary)]" />
                    <p className="text-sm text-[var(--split-text-secondary)]">
                      {scanState === 'starting'     && 'Starting camera…'}
                      {scanState === 'redirecting'  && 'Opening…'}
                      {scanState === 'denied'       && 'Camera access was blocked. Enable it in your browser settings, then try again.'}
                      {scanState === 'unsupported'  && 'Camera scanning needs camera access over a secure (HTTPS) connection.'}
                      {scanState === 'idle'         && 'Preparing…'}
                    </p>
                    {scanState === 'denied' && (
                      <button
                        type="button"
                        onClick={() => { stopScanner(); void startScanning() }}
                        className="text-xs font-medium text-[var(--split-accent)] hover:underline"
                      >
                        Try again
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {scanResult && (
              <div className="rounded-xl border border-[var(--split-border)] bg-[var(--split-bg-secondary)] p-3 space-y-2">
                <p className="text-xs text-[var(--split-text-secondary)]">Not a Split code — found:</p>
                <p className="text-xs font-mono break-all text-[var(--split-text-primary)]">{scanResult}</p>
                <button
                  type="button"
                  onClick={() => { void navigator.clipboard.writeText(scanResult).catch(() => {}) }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--split-accent)] hover:underline"
                >
                  <Copy size={13} /> Copy
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
