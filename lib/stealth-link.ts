import 'server-only'
import { randomBytes } from 'node:crypto'

// Opaque token for the private pay link, so the URL is shaped exactly like a
// normal pay link (/pay/{token}) and never spells out "private".
//
// Length is load-bearing, not arbitrary: handles are capped at 20 characters by
// HANDLE_RE (/^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$/), so a 24-character token can
// never be registered as a handle. Link-squatting is therefore impossible by
// construction rather than by a runtime check somebody could forget.
export const LINK_TOKEN_BYTES  = 12
export const LINK_TOKEN_LENGTH = LINK_TOKEN_BYTES * 2  // 24 hex chars, 96 bits

const LINK_TOKEN_RE = new RegExp(`^[0-9a-f]{${LINK_TOKEN_LENGTH}}$`)

export function generateLinkToken(): string {
  return randomBytes(LINK_TOKEN_BYTES).toString('hex')
}

/**
 * Whether an identifier from the URL is shaped like a link token. Used to decide
 * which lookup to run, so a normal handle never triggers a token query.
 */
export function isLinkToken(identifier: string): boolean {
  return LINK_TOKEN_RE.test(identifier)
}
