'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { Plus, Trash2, Pause, Play, Download, Users, PlayCircle, Loader2, Pencil, Check, X, EyeOff } from 'lucide-react'
import { formatUsdc, shortAddress } from '@/lib/format'
import {
  usePayrollApi,
  type PayrollSummary, type PayeeRecord, type RunSummary,
} from '@/hooks/use-payroll'
import { RunDialog } from '@/components/payroll/run-dialog'

function fmt(raw: string | number): string {
  try { return formatUsdc(BigInt(String(raw))) } catch { return '?' }
}

const OUTCOME_LABEL: Record<number, string> = { 0: 'split', 1: 'unsplit (fallback)', 2: 'direct', 3: 'private' }

export default function PayrollPage() {
  const { isConnected } = useAccount()
  const api = usePayrollApi()

  const [payrolls, setPayrolls]     = useState<PayrollSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [payees, setPayees]         = useState<PayeeRecord[]>([])
  const [runs, setRuns]             = useState<RunSummary[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [runOpen, setRunOpen]       = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const selected = payrolls.find((p) => p.id === selectedId) ?? null

  const loadPayrolls = useCallback(async () => {
    try {
      const list = await api.listPayrolls()
      if (!mounted.current) return
      setPayrolls(list)
      setSelectedId((cur) => cur ?? list[0]?.id ?? null)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Failed to load payrolls')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [api])

  const loadRoster = useCallback(async (id: string) => {
    try {
      const [{ payees }, runList] = await Promise.all([api.getPayroll(id), api.listRuns(id)])
      if (!mounted.current) return
      setPayees(payees)
      setRuns(runList)
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'Failed to load roster')
    }
  }, [api])

  useEffect(() => { if (isConnected) loadPayrolls() }, [isConnected, loadPayrolls])
  useEffect(() => { if (selectedId) loadRoster(selectedId) }, [selectedId, loadRoster])

  async function refresh() { if (selectedId) await loadRoster(selectedId) }

  const activeCount = payees.filter((p) => p.active).length
  const activeTotal = payees.filter((p) => p.active).reduce((acc, p) => acc + BigInt(String(p.amount_raw)), 0n)

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 60, color: 'var(--text-3)' }}><Loader2 className="animate-spin" /></div>
  }

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.02em' }}>Payroll</h1>
        <p style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 2 }}>Pay a whole team in one action. Split users auto-split; everyone else gets a direct transfer.</p>
      </header>

      {error && <p role="alert" style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 12 }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,240px) minmax(0,1fr)', gap: 16, alignItems: 'start' }} className="sp-payroll-grid">
        <PayrollList
          payrolls={payrolls}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCreate={async (name) => { const p = await api.createPayroll(name); setPayrolls((cur) => [p, ...cur]); setSelectedId(p.id) }}
        />

        {selected ? (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            {/* Roster card */}
            <div style={card()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{selected.name}</h2>
                  <p style={{ fontSize: 12, color: 'var(--text-3)' }}>{activeCount} active · {fmt(activeTotal.toString())} USDC per run</p>
                </div>
                <button type="button" disabled={activeCount === 0} onClick={() => setRunOpen(true)}
                  style={{ ...primaryBtn(activeCount > 0), display: 'inline-flex', alignItems: 'center', gap: 7, width: 'auto', padding: '0 16px', height: 40 }}>
                  <PlayCircle size={16} /> Review &amp; run
                </button>
              </div>

              <AddPayeeForm onAdd={async (label, recipient, amount) => {
                await api.addPayee(selected.id, label, recipient, amount); await refresh()
              }} />

              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column' }}>
                {payees.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--text-3)', fontSize: 13 }}>
                    <Users size={22} style={{ opacity: 0.5, marginBottom: 6 }} /><br />No payees yet. Add your first above.
                  </div>
                )}
                {payees.map((p) => (
                  <PayeeRow key={p.id} payee={p}
                    onSave={async (patch) => { await api.editPayee(p.id, patch); await refresh() }}
                    onDelete={async () => { await api.deletePayee(p.id); await refresh() }}
                  />
                ))}
              </div>

              {payees.some((p) => p.pay_private) && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-start', background: 'rgba(139,124,246,.08)', border: '0.5px solid rgba(139,124,246,.25)', borderRadius: 12, padding: '11px 13px' }}>
                  <EyeOff size={14} style={{ color: '#8B7CF6', flexShrink: 0, marginTop: 2 }} />
                  <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
                    Private payees are paid at fresh one-time addresses, hidden from other clients and chain watchers, <strong style={{ color: 'var(--text)' }}>but not from you</strong>: you still see who is on this roster and what each is paid. It only works for payees who turned on private payments, and only protects them if they route the funds to a wallet they keep private, not one they already use publicly.
                  </p>
                </div>
              )}
            </div>

            {/* Run history */}
            <RunHistory runs={runs} onExport={async (runId) => {
              const { run, items } = await api.getRun(runId)
              downloadCsv(run, items, selected.name)
            }} />
          </section>
        ) : (
          <div style={{ ...card(), textAlign: 'center', color: 'var(--text-3)', fontSize: 14, padding: 40 }}>
            Create a payroll to get started.
          </div>
        )}
      </div>

      {runOpen && selected && (
        <RunDialog payrollId={selected.id} payrollName={selected.name}
          onClose={() => { setRunOpen(false); refresh() }}
          onComplete={refresh} />
      )}

      <style>{`@media (max-width: 720px){ .sp-payroll-grid{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  )
}

// ── Payroll list + create ─────────────────────────────────────────────────────

function PayrollList({ payrolls, selectedId, onSelect, onCreate }: {
  payrolls: PayrollSummary[]; selectedId: string | null
  onSelect: (id: string) => void; onCreate: (name: string) => Promise<void>
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div style={{ ...card(), padding: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {payrolls.map((p) => {
          const active = p.id === selectedId
          return (
            <button key={p.id} type="button" onClick={() => onSelect(p.id)}
              style={{ textAlign: 'left', padding: '9px 11px', borderRadius: 10, border: '0.5px solid ' + (active ? 'var(--accent-border)' : 'transparent'),
                background: active ? 'var(--accent-bg)' : 'transparent', color: active ? 'var(--text)' : 'var(--text-2)', fontSize: 13, fontWeight: active ? 700 : 500, cursor: 'pointer' }}>
              {p.name}
            </button>
          )
        })}
      </div>
      {creating ? (
        <form onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; setBusy(true); try { await onCreate(name.trim()); setName(''); setCreating(false) } finally { setBusy(false) } }}
          style={{ marginTop: 8, display: 'flex', gap: 6 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Payroll name" maxLength={60}
            style={inputStyle()} />
          <button type="submit" disabled={busy} aria-label="Create" style={iconBtn('var(--accent)')}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />}</button>
        </form>
      ) : (
        <button type="button" onClick={() => setCreating(true)}
          style={{ marginTop: 8, width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '9px 0', borderRadius: 10, border: '0.5px dashed var(--border)', background: 'transparent', color: 'var(--text-2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <Plus size={15} /> New payroll
        </button>
      )}
    </div>
  )
}

// ── Add payee ─────────────────────────────────────────────────────────────────

function AddPayeeForm({ onAdd }: { onAdd: (label: string, recipient: string, amount: string) => Promise<void> }) {
  const [label, setLabel] = useState('')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null)
    if (!label.trim() || !recipient.trim() || !amount.trim()) { setErr('Fill in every field'); return }
    setBusy(true)
    try { await onAdd(label.trim(), recipient.trim(), amount.trim()); setLabel(''); setRecipient(''); setAmount('') }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to add payee') }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg-3)', borderRadius: 12, border: '0.5px solid var(--border)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr 0.9fr auto', gap: 8 }} className="sp-addpayee">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name / label" maxLength={60} style={inputStyle()} />
        <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="@handle or 0x address" style={{ ...inputStyle(), fontFamily: 'var(--font-mono)' }} />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount" style={{ ...inputStyle(), textAlign: 'right' }} />
        <button type="submit" disabled={busy} style={{ ...primaryBtn(true), width: 'auto', padding: '0 14px', height: 38, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={15} />} Add
        </button>
      </div>
      {err && <p role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</p>}
      <style>{`@media (max-width:640px){ .sp-addpayee{ grid-template-columns:1fr 1fr !important; } }`}</style>
    </form>
  )
}

// ── Payee row (view + inline edit) ────────────────────────────────────────────

function PayeeRow({ payee, onSave, onDelete }: {
  payee: PayeeRecord
  onSave: (patch: { label?: string; amount?: string; active?: boolean; payPrivate?: boolean }) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(payee.label)
  const [amount, setAmount] = useState(formatUsdc(BigInt(String(payee.amount_raw))))
  const [busy, setBusy] = useState(false)

  async function act(fn: () => Promise<void>) { setBusy(true); try { await fn() } finally { setBusy(false) } }

  const dim = payee.active ? 1 : 0.5
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px', borderTop: '0.5px solid var(--border)', opacity: dim }}>
      {editing ? (
        <>
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...inputStyle(), flex: 1 }} maxLength={60} />
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" style={{ ...inputStyle(), width: 90, textAlign: 'right' }} />
          <button type="button" aria-label="Save" disabled={busy} onClick={() => act(async () => { await onSave({ label, amount }); setEditing(false) })} style={iconBtn('var(--accent)')}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />}</button>
          <button type="button" aria-label="Cancel" onClick={() => { setEditing(false); setLabel(payee.label); setAmount(formatUsdc(BigInt(String(payee.amount_raw)))) }} style={iconBtn('var(--text-3)')}><X size={15} /></button>
        </>
      ) : (
        <>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{payee.label}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: payee.is_split_user ? 'var(--accent-bg)' : 'var(--bg-3)', color: payee.is_split_user ? 'var(--accent)' : 'var(--text-3)', border: '0.5px solid var(--border)' }}>
                {payee.is_split_user ? 'splits' : 'direct'}
              </span>
              {payee.pay_private && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'rgba(139,124,246,.12)', color: '#8B7CF6', border: '0.5px solid rgba(139,124,246,.3)' }}><EyeOff size={9} /> private</span>}
              {!payee.active && <span style={{ fontSize: 10, color: 'var(--text-3)' }}>paused</span>}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {payee.handle ? `@${payee.handle}` : shortAddress(payee.pinned_address as `0x${string}`)}
            </span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{fmt(payee.amount_raw)}</span>
          <div style={{ display: 'flex', gap: 2 }}>
            <button type="button" aria-label="Edit" onClick={() => setEditing(true)} style={iconBtn('var(--text-3)')}><Pencil size={14} /></button>
            <button type="button" aria-label={payee.pay_private ? 'Turn off private pay' : 'Pay privately'} aria-pressed={!!payee.pay_private} disabled={busy}
              onClick={() => act(() => onSave({ payPrivate: !payee.pay_private }))}
              style={iconBtn(payee.pay_private ? '#8B7CF6' : 'var(--text-3)')}><EyeOff size={14} /></button>
            <button type="button" aria-label={payee.active ? 'Pause' : 'Resume'} disabled={busy} onClick={() => act(() => onSave({ active: !payee.active }))} style={iconBtn('var(--text-3)')}>{payee.active ? <Pause size={14} /> : <Play size={14} />}</button>
            <button type="button" aria-label="Remove" disabled={busy} onClick={() => act(onDelete)} style={iconBtn('var(--danger)')}><Trash2 size={14} /></button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Run history ───────────────────────────────────────────────────────────────

function RunHistory({ runs, onExport }: { runs: RunSummary[]; onExport: (runId: string) => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  if (runs.length === 0) return null
  return (
    <div style={card()}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>Run history</h3>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {runs.map((r) => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 2px', borderTop: '0.5px solid var(--border)' }}>
            <StatusPill status={r.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{fmt(r.total_raw)} USDC · {r.payee_count} payees</p>
              <p style={{ fontSize: 11, color: 'var(--text-3)' }}>{new Date(r.created_at).toLocaleString()} · {r.chunks_confirmed}/{r.chunk_count} tx confirmed</p>
            </div>
            <button type="button" aria-label="Export CSV" disabled={busyId === r.id}
              onClick={async () => { setBusyId(r.id); try { await onExport(r.id) } finally { setBusyId(null) } }}
              style={iconBtn('var(--text-3)')}>{busyId === r.id ? <Loader2 size={14} className="animate-spin" /> : <Download size={15} />}</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    completed: ['var(--accent)', 'var(--accent-bg)'],
    executing: ['var(--warning)', 'var(--warning-bg)'],
    partial:   ['var(--warning)', 'var(--warning-bg)'],
    failed:    ['var(--danger)', 'var(--danger-bg)'],
    draft:     ['var(--text-3)', 'var(--bg-3)'],
  }
  const [color, bg] = map[status] ?? ['var(--text-3)', 'var(--bg-3)']
  return <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: bg, color, textTransform: 'capitalize' }}>{status}</span>
}

// ── CSV export ────────────────────────────────────────────────────────────────

function downloadCsv(run: RunSummary, items: { label: string | null; payee_dest: string; amount_raw: string | number; is_split_user: boolean; outcome: number | null; tx_hash: string | null }[], payrollName: string) {
  const rows = [
    ['label', 'address', 'amount_usdc', 'intended', 'result', 'tx_hash'],
    ...items.map((it) => [
      it.label ?? '', it.payee_dest, fmt(it.amount_raw),
      it.is_split_user ? 'split' : 'direct',
      it.outcome === null ? 'pending' : (OUTCOME_LABEL[it.outcome] ?? String(it.outcome)),
      it.tx_hash ?? '',
    ]),
  ]
  // Quote every cell and neutralize spreadsheet formula injection: a label like
  // "=cmd()" must not execute when the CSV is opened in Excel/Sheets.
  const cell = (v: unknown): string => {
    let s = String(v)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return `"${s.replace(/"/g, '""')}"`
  }
  const csv = rows.map((r) => r.map(cell).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${payrollName.replace(/\s+/g, '-')}-run-${new Date(run.created_at).toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── shared styles ─────────────────────────────────────────────────────────────

function card(): React.CSSProperties {
  return { background: 'var(--bg-2)', border: '0.5px solid var(--border)', borderRadius: 16, padding: 16 }
}
function inputStyle(): React.CSSProperties {
  return { minWidth: 0, height: 38, padding: '0 10px', borderRadius: 9, border: '0.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none' }
}
function primaryBtn(enabled: boolean): React.CSSProperties {
  return { width: '100%', height: 40, borderRadius: 10, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', background: enabled ? 'linear-gradient(135deg, var(--accent-dark) 0%, var(--accent) 100%)' : 'var(--bg-3)', color: enabled ? '#04110B' : 'var(--text-3)', fontSize: 13, fontWeight: 700 }
}
function iconBtn(color: string): React.CSSProperties {
  return { width: 32, height: 32, borderRadius: 8, border: '0.5px solid var(--border)', background: 'var(--bg-3)', color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }
}
