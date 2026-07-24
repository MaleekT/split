'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount, useWriteContract } from 'wagmi'
import { X, AlertTriangle, ShieldAlert, Check, Loader2, ArrowRight } from 'lucide-react'
import { publicClient } from '@/lib/arc'
import { USDC, erc20Abi } from '@/lib/contracts'
import { splitPayrollV2Abi, getSplitPayrollV2Contract, PAYROLL_MODE, type PayrollPayeeV2Arg } from '@/lib/payroll-contracts'
import { generateStealthPayment, buildAnnouncementMetadata } from '@/lib/stealth'
import { formatUsdc } from '@/lib/format'
import { usePayrollApi, type ResolveEntry, type RunPlan, type RunItem } from '@/hooks/use-payroll'

const EMPTY_BYTES = '0x' as const

const RECEIPT_TIMEOUT_MS = 60_000

type Phase = 'resolving' | 'review' | 'resume' | 'executing' | 'done' | 'error'

// One chunk of a resumable run, with whether it already landed on-chain.
interface ResumeChunk {
  chunkIndex: number
  runId:      string
  items:      RunItem[]   // ordered by item_index
  sent:       boolean     // indexer-reconciled OR tx hash confirmed successful
}
interface ResumeState {
  runRef:      string
  chunks:      ResumeChunk[]
  sentCount:   number
  unsentCount: number
}

interface Props {
  payrollId: string
  payrollName: string
  onClose: () => void
  onComplete: () => void
}

function fmt(raw: string | number): string {
  try { return formatUsdc(BigInt(String(raw))) } catch { return '?' }
}

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export function RunDialog({ payrollId, payrollName, onClose, onComplete }: Props) {
  const api = usePayrollApi()
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const [phase, setPhase]       = useState<Phase>('resolving')
  const [entries, setEntries]   = useState<ResolveEntry[]>([])
  const [summary, setSummary]   = useState<{ totalRaw: string; payeeCount: number; chunkCount: number; hasBlocking: boolean; requiresConfirmation: boolean } | null>(null)
  const [acknowledged, setAck]  = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [busyId, setBusyId]     = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string }>({ done: 0, total: 0, label: '' })
  const [resume, setResume]     = useState<ResumeState | null>(null)
  const [cancelArmed, setCancelArmed] = useState(false)

  async function runResolve() {
    setPhase('resolving'); setError(null)
    try {
      const res = await api.resolve(payrollId)
      if (!mounted.current) return
      setEntries(res.entries)
      setSummary(res.summary)
      setAck(false)
      setPhase('review')
    } catch (e) {
      if (mounted.current) { setError(e instanceof Error ? e.message : 'Failed to resolve'); setPhase('error') }
    }
  }

  // On open, an unfinished (executing/partial) run takes precedence: offer to
  // resume it rather than start a fresh run that would re-pay landed chunks.
  async function init() {
    setPhase('resolving'); setError(null)
    try {
      const runs = await api.listRuns(payrollId)
      const unfinished = runs.find((r) => r.status === 'executing' || r.status === 'partial')
      if (unfinished) { await loadResume(unfinished.id); return }
    } catch { /* fall through to a normal resolve */ }
    await runResolve()
  }

  useEffect(() => { init() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

  // Whether a chunk already landed: any item reconciled by the indexer, or its
  // recorded tx hash confirms successful on-chain. Never re-send a landed chunk.
  async function chunkIsSent(items: RunItem[]): Promise<boolean> {
    if (items.some((it) => it.outcome !== null && it.outcome !== undefined)) return true
    const txHash = items.find((it) => it.tx_hash)?.tx_hash
    if (!txHash) return false
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` })
      return receipt.status === 'success'
    } catch { return false } // not found / pending / dropped -> treat as unsent
  }

  async function loadResume(runRef: string) {
    setPhase('resolving'); setError(null)
    try {
      const { items } = await api.getRun(runRef)
      const byChunk = new Map<number, RunItem[]>()
      for (const it of items) {
        const arr = byChunk.get(it.chunk_index) ?? []
        arr.push(it)
        byChunk.set(it.chunk_index, arr)
      }
      const chunks: ResumeChunk[] = []
      for (const [chunkIndex, its] of [...byChunk.entries()].sort((a, b) => a[0] - b[0])) {
        const ordered = [...its].sort((a, b) => a.item_index - b.item_index)
        chunks.push({
          chunkIndex,
          runId: ordered[0]?.chunk_run_id ?? '',
          items: ordered,
          sent:  await chunkIsSent(ordered),
        })
      }
      if (!mounted.current) return
      const sentCount = chunks.filter((c) => c.sent).length
      setResume({ runRef, chunks, sentCount, unsentCount: chunks.length - sentCount })
      setPhase('resume')
    } catch (e) {
      if (mounted.current) { setError(e instanceof Error ? e.message : 'Failed to load the unfinished run'); setPhase('error') }
    }
  }

  // Rebuild a chunk's on-chain args from its stored snapshot. Private payees get
  // a freshly computed stealth address (the chunk was never sent, so this is its
  // first and only announcement); the stored chunk_run_id is reused so the
  // indexer still reconciles by (chunk_run_id, item_index).
  async function buildResumeArgs(items: RunItem[]): Promise<PayrollPayeeV2Arg[]> {
    const args: PayrollPayeeV2Arg[] = []
    for (const it of items) {
      const amount   = BigInt(String(it.amount_raw))
      const memoHash = it.memo_hash as `0x${string}`
      if (it.mode === PAYROLL_MODE.PRIVATE) {
        const meta = await api.lookupMetaAddress(it.payee_dest)
        if (!meta) throw new Error(`Cannot resume private payee ${short(it.payee_dest)}: no published meta-address`)
        const sp = generateStealthPayment(meta)
        args.push({ dest: sp.stealthAddress, amount, mode: PAYROLL_MODE.PRIVATE, memoHash, ephemeralPubKey: sp.ephemeralPublicKey, metadata: buildAnnouncementMetadata(sp.viewTag) })
      } else {
        args.push({ dest: it.payee_dest as `0x${string}`, amount, mode: it.mode, memoHash, ephemeralPubKey: EMPTY_BYTES, metadata: EMPTY_BYTES })
      }
    }
    return args
  }

  // Finish an unfinished run: pay only the chunks that have not landed.
  async function executeResume() {
    if (!resume || !address) { setError('Connect your wallet'); return }
    const unsent = resume.chunks.filter((c) => !c.sent && c.runId)
    if (unsent.length === 0) {
      try { await api.setRunStatus(resume.runRef, 'completed') } catch { /* best effort */ }
      if (mounted.current) { setPhase('done'); onComplete() }
      return
    }
    setPhase('executing')
    setProgress({ done: 0, total: unsent.length, label: 'Preparing…' })
    try {
      const v2 = getSplitPayrollV2Contract()
      let remaining = 0n
      for (const c of unsent) for (const it of c.items) remaining += BigInt(String(it.amount_raw))

      const allowance = await publicClient.readContract({
        address: USDC, abi: erc20Abi, functionName: 'allowance', args: [address as `0x${string}`, v2],
      }) as bigint
      if (allowance < remaining) {
        setProgress((p) => ({ ...p, label: 'Approve USDC spend…' }))
        const approveTx = await writeContractAsync({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [v2, remaining] })
        await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: RECEIPT_TIMEOUT_MS })
      }

      for (let i = 0; i < unsent.length; i++) {
        const c = unsent[i]!
        setProgress({ done: i, total: unsent.length, label: `Paying chunk ${c.chunkIndex + 1}…` })
        const payees = await buildResumeArgs(c.items)
        const tx = await writeContractAsync({ address: v2, abi: splitPayrollV2Abi, functionName: 'runPayroll', args: [payees, BigInt(c.runId)] })
        await api.recordChunkTx(resume.runRef, c.chunkIndex, tx) // record on submit, before awaiting
        await publicClient.waitForTransactionReceipt({ hash: tx, timeout: RECEIPT_TIMEOUT_MS })
        setProgress({ done: i + 1, total: unsent.length, label: `Chunk ${c.chunkIndex + 1} confirmed` })
      }
      await api.setRunStatus(resume.runRef, 'completed')
      if (mounted.current) { setPhase('done'); onComplete() }
    } catch (e) {
      try { await api.setRunStatus(resume.runRef, 'partial') } catch { /* best effort */ }
      if (mounted.current) { setError(e instanceof Error ? e.message : 'Payment failed'); setPhase('error') }
    }
  }

  // Abandon an unfinished run. Chunks already paid are NOT reversed; the employer
  // acknowledges that before a fresh run (which would pay everyone again) is allowed.
  async function cancelRun() {
    if (!resume) return
    setBusyId('cancel')
    try {
      await api.setRunStatus(resume.runRef, 'failed')
      if (!mounted.current) return
      setResume(null)
      await runResolve()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Could not cancel the run')
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  async function reconfirm(entry: ResolveEntry) {
    setBusyId(entry.payeeId); setError(null)
    try {
      await api.editPayee(entry.payeeId, { reconfirmAddress: true })
      await runResolve()
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Re-confirm failed')
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  async function execute() {
    if (!address) { setError('Connect your wallet'); return }
    setError(null)
    // Create the run (server re-checks the gate authoritatively).
    const created = await api.createRun(payrollId, acknowledged)
    if (!created.ok) {
      // An unfinished run appeared: switch to resuming it instead of double-paying.
      if (created.reason === 'resumable' && created.runRef) { await loadResume(created.runRef); return }
      // A race changed the roster between preview and run: surface and re-resolve.
      setError(created.message)
      if (created.reason === 'blocking' || created.reason === 'confirm') await runResolve()
      return
    }
    await executePlan(created.plan)
  }

  async function executePlan(plan: RunPlan) {
    setPhase('executing')
    setProgress({ done: 0, total: plan.chunks.length, label: 'Checking allowance…' })
    try {
      // 1. Approve the run total once, if the current allowance is short.
      const total = BigInt(plan.totalRaw)
      const allowance = await publicClient.readContract({
        address: USDC, abi: erc20Abi, functionName: 'allowance',
        args: [address as `0x${string}`, plan.splitPayroll],
      }) as bigint
      if (allowance < total) {
        setProgress((p) => ({ ...p, label: 'Approve USDC spend…' }))
        const approveTx = await writeContractAsync({
          address: USDC, abi: erc20Abi, functionName: 'approve', args: [plan.splitPayroll, total],
        })
        await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: RECEIPT_TIMEOUT_MS })
      }

      // 2. One runPayroll (V2) transaction per chunk. For private payees the
      //    one-time stealth address is computed here, on the employer's device,
      //    from the payee's published meta-address; the contract forwards to it
      //    and announces so only the contractor can detect the payment.
      for (const c of plan.chunks) {
        setProgress({ done: c.chunkIndex, total: plan.chunks.length, label: `Paying chunk ${c.chunkIndex + 1} of ${plan.chunks.length}…` })
        const payees: PayrollPayeeV2Arg[] = c.payees.map((p) => {
          if (p.mode === PAYROLL_MODE.PRIVATE && p.metaAddress) {
            const sp = generateStealthPayment(p.metaAddress)
            return {
              dest: sp.stealthAddress, amount: BigInt(p.amount), mode: PAYROLL_MODE.PRIVATE,
              memoHash: p.memoHash, ephemeralPubKey: sp.ephemeralPublicKey,
              metadata: buildAnnouncementMetadata(sp.viewTag),
            }
          }
          return {
            dest: p.dest, amount: BigInt(p.amount), mode: p.mode,
            memoHash: p.memoHash, ephemeralPubKey: EMPTY_BYTES, metadata: EMPTY_BYTES,
          }
        })
        const tx = await writeContractAsync({
          address: plan.splitPayroll, abi: splitPayrollV2Abi, functionName: 'runPayroll',
          args: [payees, BigInt(c.runId)],
        })
        await api.recordChunkTx(plan.runRef, c.chunkIndex, tx) // record on submit, before awaiting
        await publicClient.waitForTransactionReceipt({ hash: tx, timeout: RECEIPT_TIMEOUT_MS })
        setProgress({ done: c.chunkIndex + 1, total: plan.chunks.length, label: `Chunk ${c.chunkIndex + 1} confirmed` })
      }

      await api.setRunStatus(plan.runRef, 'completed')
      if (mounted.current) { setPhase('done'); onComplete() }
    } catch (e) {
      // Mark the run partial so it can be resumed; the indexer reconciles what landed.
      try { await api.setRunStatus(plan.runRef, 'partial') } catch { /* best effort */ }
      if (mounted.current) {
        setError(e instanceof Error ? e.message : 'Payment failed')
        setPhase('error')
      }
    }
  }

  const blocking = entries.filter((e) => e.blocking)
  const softChanges = entries.filter((e) => e.requiresConfirmation)
  const warnings = entries.filter((e) => !e.blocking && e.hasBuckets && !e.bucketsValid)
  const canRun = phase === 'review' && !summary?.hasBlocking && (!summary?.requiresConfirmation || acknowledged)

  return (
    <div role="dialog" aria-modal="true" aria-label={`Run payroll: ${payrollName}`}
      style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget && phase !== 'executing') onClose() }}>
      <div style={{ width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 18, boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px', borderBottom: '0.5px solid var(--border)' }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Review &amp; run</h2>
            <p style={{ fontSize: 12, color: 'var(--text-3)' }}>{payrollName}</p>
          </div>
          {phase !== 'executing' && (
            <button type="button" aria-label="Close" onClick={onClose} style={{ color: 'var(--text-3)', padding: 4 }}>
              <X size={18} />
            </button>
          )}
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {phase === 'resolving' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-2)', fontSize: 14, padding: '24px 0', justifyContent: 'center' }}>
              <Loader2 size={18} className="animate-spin" /> Checking every payee against last time…
            </div>
          )}

          {phase === 'resume' && resume && (() => {
            const unsent = resume.chunks.filter((c) => !c.sent)
            const remainingPayees = unsent.reduce((n, c) => n + c.items.length, 0)
            const remainingRaw = unsent.reduce((acc, c) => acc + c.items.reduce((a, it) => a + BigInt(String(it.amount_raw)), 0n), 0n)
            const allDone = unsent.length === 0
            return (
              <>
                <Section tone="warning" icon={<AlertTriangle size={15} />} title="Unfinished run">
                  <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55 }}>
                    {allDone
                      ? 'Every batch of this run already went out. Marking it complete, no payment needed.'
                      : `${resume.sentCount} of ${resume.chunks.length} batches already went out. Resuming pays only the remaining ${unsent.length}; already-paid batches are never re-sent. Cancelling abandons the run and does not reverse what was already paid.`}
                  </p>
                </Section>

                {!allDone && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                    <Stat label="Remaining" value={`${fmt(remainingRaw.toString())} USDC`} />
                    <Stat label="Payees left" value={String(remainingPayees)} />
                    <Stat label="Batches left" value={String(unsent.length)} />
                  </div>
                )}

                {error && <p role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</p>}

                <button type="button" onClick={executeResume}
                  style={{ ...btnPrimary(true), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  {allDone ? 'Mark run complete' : <>Resume - pay {fmt(remainingRaw.toString())} USDC <ArrowRight size={16} /></>}
                </button>

                {cancelArmed ? (
                  <div style={{ background: 'var(--danger-bg)', border: '0.5px solid var(--danger)', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
                      Cancel this run? The {resume.sentCount} batch{resume.sentCount === 1 ? '' : 'es'} already paid will <strong style={{ color: 'var(--text)' }}>not</strong> be reversed. Starting a new run afterwards pays everyone again, including those already paid.
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" disabled={busyId === 'cancel'} onClick={cancelRun} style={{ ...btnSecondary(), color: 'var(--danger)', borderColor: 'var(--danger)' }}>
                        {busyId === 'cancel' ? <Loader2 size={13} className="animate-spin" /> : 'Yes, cancel run'}
                      </button>
                      <button type="button" onClick={() => setCancelArmed(false)} style={btnSecondary()}>Keep it</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setCancelArmed(true)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, color: 'var(--text-3)', textDecoration: 'underline', textUnderlineOffset: 2, alignSelf: 'center' }}>
                    Cancel this run instead
                  </button>
                )}
              </>
            )
          })()}

          {phase === 'review' && summary && (
            <>
              {/* Summary band */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                <Stat label="Total" value={`${fmt(summary.totalRaw)} USDC`} />
                <Stat label="Payees" value={String(summary.payeeCount)} />
                <Stat label="Transactions" value={String(summary.chunkCount)} />
              </div>

              {/* Blocking: must re-confirm */}
              {blocking.length > 0 && (
                <Section tone="danger" icon={<ShieldAlert size={15} />} title={`${blocking.length} payee${blocking.length > 1 ? 's' : ''} need re-confirmation`}>
                  <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
                    A pay-link now points to a different address than before, or no longer resolves. Nothing sends until you re-confirm each one.
                  </p>
                  {blocking.map((e) => (
                    <div key={e.payeeId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{e.label}</p>
                        <p style={{ fontSize: 11, color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>
                          {e.kind === 'unresolved' ? 'handle no longer resolves' : `was ${short(e.pinnedAddress)} → now ${e.resolvedAddress ? short(e.resolvedAddress) : '-'}`}
                        </p>
                      </div>
                      {e.kind === 'address_changed' && (
                        <button type="button" onClick={() => reconfirm(e)} disabled={busyId === e.payeeId}
                          style={btnSmall('var(--danger)')}>
                          {busyId === e.payeeId ? <Loader2 size={13} className="animate-spin" /> : 'Re-confirm'}
                        </button>
                      )}
                    </div>
                  ))}
                </Section>
              )}

              {/* Soft changes: acknowledge */}
              {softChanges.length > 0 && (
                <Section tone="warning" icon={<AlertTriangle size={15} />} title={`${softChanges.length} new or changed`}>
                  {softChanges.map((e) => (
                    <div key={e.payeeId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '5px 0', color: 'var(--text-2)' }}>
                      <span style={{ color: 'var(--text)' }}>{e.label}</span>
                      <span>{e.kind === 'new' ? 'new payee' : `${e.previousAmountRaw ? fmt(e.previousAmountRaw) : '-'} → ${fmt(e.currentAmountRaw)} USDC`}</span>
                    </div>
                  ))}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={acknowledged} onChange={(e) => setAck(e.target.checked)} />
                    I&apos;ve reviewed these changes
                  </label>
                </Section>
              )}

              {/* Bucket warnings (non-blocking, informational) */}
              {warnings.length > 0 && (
                <Section tone="warning" icon={<AlertTriangle size={15} />} title="Heads up">
                  {warnings.map((e) => (
                    <p key={e.payeeId} style={{ fontSize: 12, color: 'var(--text-2)', padding: '3px 0' }}>
                      <span style={{ color: 'var(--text)' }}>{e.label}</span>&apos;s split rules don&apos;t add up to 100% - they&apos;ll receive an unsplit transfer.
                    </p>
                  ))}
                </Section>
              )}

              {error && <p role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</p>}

              <button type="button" onClick={execute} disabled={!canRun}
                style={{ ...btnPrimary(canRun), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                Pay {fmt(summary.totalRaw)} USDC to {summary.payeeCount} <ArrowRight size={16} />
              </button>
            </>
          )}

          {phase === 'executing' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text)', fontSize: 14 }}>
                <Loader2 size={18} className="animate-spin" style={{ color: 'var(--accent)' }} /> {progress.label}
              </div>
              <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-3)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: 'linear-gradient(90deg, var(--accent-dark), var(--accent))', transition: 'width .3s ease' }} />
              </div>
              <p style={{ fontSize: 12, color: 'var(--text-3)' }}>Keep this open and approve each wallet prompt. {progress.done}/{progress.total} transactions confirmed.</p>
            </div>
          )}

          {phase === 'done' && (
            <div style={{ textAlign: 'center', padding: '20px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 52, height: 52, borderRadius: 999, background: 'var(--accent-bg)', border: '1px solid var(--accent-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Check size={24} style={{ color: 'var(--accent)' }} />
              </div>
              <p style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Payroll sent</p>
              <p style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 360 }}>
                Every payee has been paid. Split users had their buckets filled automatically; others received a direct transfer.
              </p>
              <button type="button" onClick={onClose} style={btnPrimary(true)}>Done</button>
            </div>
          )}

          {phase === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p role="alert" style={{ fontSize: 13, color: 'var(--danger)' }}>{error ?? 'Something went wrong.'}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={runResolve} style={btnSecondary()}>Try again</button>
                <button type="button" onClick={onClose} style={btnSecondary()}>Close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── small presentational helpers ──────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 12, padding: '10px 12px' }}>
      <p style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-3)' }}>{label}</p>
      <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</p>
    </div>
  )
}

function Section({ tone, icon, title, children }: { tone: 'danger' | 'warning'; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  const color = tone === 'danger' ? 'var(--danger)' : 'var(--warning)'
  const bg    = tone === 'danger' ? 'var(--danger-bg)' : 'var(--warning-bg)'
  return (
    <div style={{ background: bg, border: `0.5px solid ${color}`, borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, color, fontSize: 13, fontWeight: 700 }}>
        {icon} {title}
      </div>
      {children}
    </div>
  )
}

function btnPrimary(enabled: boolean): React.CSSProperties {
  return {
    width: '100%', height: 46, borderRadius: 12, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed',
    background: enabled ? 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)' : 'var(--bg-3)',
    color: enabled ? '#04110B' : 'var(--text-3)', fontSize: 14, fontWeight: 700,
  }
}
function btnSecondary(): React.CSSProperties {
  return { flex: 1, height: 40, borderRadius: 10, border: '0.5px solid var(--border)', background: 'var(--bg-3)', color: 'var(--text)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
}
function btnSmall(color: string): React.CSSProperties {
  return { flexShrink: 0, height: 30, padding: '0 12px', borderRadius: 8, border: `0.5px solid ${color}`, background: 'transparent', color, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }
}
