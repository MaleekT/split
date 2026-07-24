'use client'

import { useCallback } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import {
  buildAuthMessage,
  encodeAuthHeader,
  PAYROLL_AUTH_HEADER,
  SESSION_TTL_MS,
  type PayrollAuthToken,
} from '@/lib/payroll-session'

// ── Client-facing shapes ──────────────────────────────────────────────────────

export interface PayrollSummary { id: string; name: string; created_at: string; updated_at: string }

export interface PayeeRecord {
  id: string; label: string; handle: string | null; pinned_address: string
  amount_raw: string | number; is_split_user: boolean; active: boolean
  pay_private?: boolean; created_at: string
}

export interface ResolveEntry {
  payeeId: string; label: string; kind: string
  pinnedAddress: `0x${string}`; resolvedAddress: `0x${string}` | null
  currentAmountRaw: string; previousAmountRaw: string | null
  requiresConfirmation: boolean; blocking: boolean
  isSplitUser: boolean; hasBuckets: boolean; bucketsValid: boolean; readOk: boolean
}
export interface ResolveSummary {
  totalRaw: string; payeeCount: number; chunkCount: number
  hasBlocking: boolean; requiresConfirmation: boolean
}
export interface ResolveResult { entries: ResolveEntry[]; summary: ResolveSummary }

export interface RunPlanPayee {
  dest: `0x${string}`; amount: string; mode: number
  memoHash: `0x${string}`; metaAddress: `0x${string}` | null
}
export interface RunPlanChunk { chunkIndex: number; runId: string; totalRaw: string; payees: RunPlanPayee[] }
export interface RunPlan {
  runRef: string; baseRunId: string; splitPayroll: `0x${string}`; usdc: `0x${string}`
  totalRaw: string; chunkCount: number; chunks: RunPlanChunk[]
}

export interface RunSummary {
  id: string; base_run_id: string; status: string; total_raw: string | number
  payee_count: number; chunk_count: number; chunks_confirmed: number; created_at: string
}
export interface RunItem {
  chunk_index: number; item_index: number; chunk_run_id: string; payee_dest: string
  label: string | null; amount_raw: string | number; is_split_user: boolean; mode: number
  memo_hash: string; outcome: number | null; tx_hash: string | null
}

export type CreateRunResult =
  | { ok: true; plan: RunPlan }
  | { ok: false; reason: 'blocking' | 'confirm' | 'resumable' | 'error'; message: string; entries?: ResolveEntry[]; runRef?: string; runStatus?: string }

// Module-level session-token cache (survives remounts), keyed by address.
const tokenCache = new Map<string, PayrollAuthToken>()

async function readJson(r: Response): Promise<Record<string, unknown>> {
  try { return (await r.json()) as Record<string, unknown> } catch { return {} }
}

export function usePayrollApi() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  // Obtain (and cache) a signed session token. Signs once per ~24h session.
  const getToken = useCallback(async (): Promise<PayrollAuthToken> => {
    if (!address) throw new Error('Connect your wallet first')
    const cached = tokenCache.get(address)
    if (cached && Date.parse(cached.expiresAt) - 60_000 > Date.now()) return cached
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
    const signature = await signMessageAsync({ message: buildAuthMessage(address, expiresAt) })
    const token: PayrollAuthToken = { address, expiresAt, signature }
    tokenCache.set(address, token)
    return token
  }, [address, signMessageAsync])

  const authedFetch = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    const token = await getToken()
    const headers = new Headers(init?.headers)
    headers.set(PAYROLL_AUTH_HEADER, encodeAuthHeader(token))
    if (init?.body) headers.set('Content-Type', 'application/json')
    return fetch(path, { ...init, headers })
  }, [getToken])

  // Read helper: returns typed `data`, throws on non-2xx.
  const call = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const r = await authedFetch(path, init)
    const body = await readJson(r)
    if (!r.ok) throw new Error((body.error as string) || `Request failed (${r.status})`)
    return body.data as T
  }, [authedFetch])

  // Mutation helper: throws on non-2xx so callers never silently succeed.
  const mutate = useCallback(async (path: string, init: RequestInit): Promise<void> => {
    const r = await authedFetch(path, init)
    if (!r.ok) throw new Error(((await readJson(r)).error as string) || `Request failed (${r.status})`)
  }, [authedFetch])

  const enc = (s: string) => encodeURIComponent(s)

  // ── Payrolls ────────────────────────────────────────────────────────────────
  const listPayrolls  = useCallback(() => call<PayrollSummary[]>('/api/payroll'), [call])
  const createPayroll = useCallback((name: string) =>
    call<PayrollSummary>('/api/payroll', { method: 'POST', body: JSON.stringify({ name }) }), [call])
  const getPayroll = useCallback((id: string) =>
    call<{ payroll: PayrollSummary; payees: PayeeRecord[] }>(`/api/payroll/${enc(id)}`), [call])
  const renamePayroll = useCallback((id: string, name: string) =>
    mutate(`/api/payroll/${enc(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }), [mutate])
  const deletePayroll = useCallback((id: string) =>
    mutate(`/api/payroll/${enc(id)}`, { method: 'DELETE' }), [mutate])

  // ── Payees ────────────────────────────────────────────────────────────────
  const addPayee = useCallback((payrollId: string, label: string, recipient: string, amount: string) =>
    call<PayeeRecord>(`/api/payroll/${enc(payrollId)}/payees`, {
      method: 'POST', body: JSON.stringify({ label, recipient, amount }),
    }), [call])
  const editPayee = useCallback((
    payeeId: string,
    patch: { label?: string; amount?: string; active?: boolean; reconfirmAddress?: boolean; payPrivate?: boolean },
  ) => mutate(`/api/payroll/payees/${enc(payeeId)}`, { method: 'PATCH', body: JSON.stringify(patch) }), [mutate])
  const deletePayee = useCallback((payeeId: string) =>
    mutate(`/api/payroll/payees/${enc(payeeId)}`, { method: 'DELETE' }), [mutate])

  // ── Resolve (preview) ────────────────────────────────────────────────────
  const resolve = useCallback((payrollId: string) =>
    call<ResolveResult>(`/api/payroll/${enc(payrollId)}/resolve`, { method: 'POST', body: JSON.stringify({}) }), [call])

  // ── Runs ────────────────────────────────────────────────────────────────
  const createRun = useCallback(async (payrollId: string, acknowledge: boolean): Promise<CreateRunResult> => {
    const r = await authedFetch(`/api/payroll/${enc(payrollId)}/runs`, {
      method: 'POST', body: JSON.stringify({ acknowledge }),
    })
    const body = await readJson(r)
    if (r.ok) return { ok: true, plan: body.data as RunPlan }
    if (r.status === 409) {
      const err = body.error as string
      // The only three 409s the server returns; an unfinished run carries a runRef.
      const reason = err === 'blocking_changes' ? 'blocking'
        : err === 'confirmation_required' ? 'confirm'
        : 'resumable'
      return {
        ok: false, reason,
        message: (body.message as string) || (body.error as string) || 'Cannot start run',
        entries:   body.entries as ResolveEntry[] | undefined,
        runRef:    body.runRef as string | undefined,
        runStatus: body.runStatus as string | undefined,
      }
    }
    return { ok: false, reason: 'error', message: (body.error as string) || 'Failed to create run' }
  }, [authedFetch])

  const listRuns = useCallback((payrollId: string) =>
    call<RunSummary[]>(`/api/payroll/${enc(payrollId)}/runs`), [call])
  const getRun = useCallback((runId: string) =>
    call<{ run: RunSummary; items: RunItem[] }>(`/api/payroll/runs/${enc(runId)}`), [call])
  const recordChunkTx = useCallback((runId: string, chunkIndex: number, txHash: string) =>
    mutate(`/api/payroll/runs/${enc(runId)}`, { method: 'PATCH', body: JSON.stringify({ chunkIndex, txHash }) }), [mutate])
  const setRunStatus = useCallback((runId: string, status: string) =>
    mutate(`/api/payroll/runs/${enc(runId)}`, { method: 'PATCH', body: JSON.stringify({ status }) }), [mutate])

  // Public stealth meta-address lookup (no auth), for rebuilding a private payee's
  // stealth address when resuming an unsent chunk.
  const lookupMetaAddress = useCallback(async (payeeAddress: string): Promise<`0x${string}` | null> => {
    try {
      const r = await fetch(`/api/stealth/${enc(payeeAddress)}`)
      if (!r.ok) return null
      const body = await r.json() as { data?: { metaAddress: string | null } }
      const meta = body.data?.metaAddress
      // Guard the shape before it feeds stealth-address computation; the SDK
      // accepts either a raw 0x meta-address or an st: URI.
      if (typeof meta !== 'string' || !(meta.startsWith('0x') || meta.startsWith('st:'))) return null
      return meta as `0x${string}`
    } catch { return null }
  }, [])

  return {
    address,
    listPayrolls, createPayroll, getPayroll, renamePayroll, deletePayroll,
    addPayee, editPayee, deletePayee,
    resolve, createRun, listRuns, getRun, recordChunkTx, setRunStatus, lookupMetaAddress,
  }
}
