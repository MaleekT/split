// Stateless signed-session auth for the private payroll API.
//
// Payroll data (rosters, amounts, runs) is private employer data, unlike the
// public profile/activity reads. There is no session backend in this app, so we
// use a wallet-signed bearer token the client obtains ONCE and reuses: the
// server verifies the signature and expiry statelessly on every request, then
// checks the signer owns the resource. No server-side session storage.
//
// Pure + isomorphic (no 'server-only'): the client builds/signs the message and
// encodes the header; the server decodes and verifies it.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export const PAYROLL_AUTH_HEADER = 'x-payroll-auth'

import { isAddress } from 'viem'

export interface PayrollAuthToken {
  readonly address:   `0x${string}`
  readonly expiresAt: string        // ISO 8601
  readonly signature: `0x${string}`
}

/**
 * Canonical message the employer signs. Human-readable in the wallet prompt and
 * deterministic so the server can reconstruct it from (address, expiresAt).
 * Guards the address format here too; the authoritative check is in the
 * server-side verifier (a tampered address otherwise just fails verifyMessage).
 */
export function buildAuthMessage(address: string, expiresAtISO: string): string {
  if (!isAddress(address)) throw new Error('buildAuthMessage: invalid address')
  return [
    'Split Payroll access',
    `Address: ${address.toLowerCase()}`,
    `Expires: ${expiresAtISO}`,
  ].join('\n')
}

/** Encode a token for the request header (ASCII-safe via URI encoding). */
export function encodeAuthHeader(token: PayrollAuthToken): string {
  return encodeURIComponent(JSON.stringify(token))
}

/** Decode a header value into a token, or null if malformed. */
export function decodeAuthHeader(value: string | null | undefined): PayrollAuthToken | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>
    if (
      typeof parsed.address === 'string' &&
      typeof parsed.expiresAt === 'string' &&
      typeof parsed.signature === 'string' &&
      parsed.address.startsWith('0x') &&
      parsed.signature.startsWith('0x')
    ) {
      return {
        address:   parsed.address as `0x${string}`,
        expiresAt: parsed.expiresAt,
        signature: parsed.signature as `0x${string}`,
      }
    }
    return null
  } catch {
    return null
  }
}
