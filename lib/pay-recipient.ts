import 'server-only'
import { isAddress, getAddress } from 'viem'
import { supabase } from '@/lib/supabase'
import { shortAddress } from '@/lib/format'
import { META_ADDRESS_RE } from '@/lib/stealth-contracts'

// Shared recipient resolution for both pay routes: /pay/[handle] (public) and
// /pay/[handle]/private (stealth). Kept in one place so the two links can never
// disagree about who they are paying.

export interface Recipient {
  address:     `0x${string}`
  displayName: string
}

/**
 * Resolve a private-link token to its owner, along with the meta-address needed
 * to pay them. Returns null for an unknown or revoked token, so a stale link
 * fails closed rather than degrading to a public payment.
 */
export async function resolveLinkToken(
  token: string,
): Promise<{ recipient: Recipient; metaAddress: `0x${string}` } | null> {
  const { data, error } = await supabase
    .from('stealth_meta')
    .select('address, meta_address')
    .eq('link_token', token)
    .maybeSingle()
  if (error || !data) return null

  const raw = data.address as unknown
  const meta: unknown = data.meta_address
  if (typeof raw !== 'string' || !isAddress(raw)) return null
  if (typeof meta !== 'string' || !META_ADDRESS_RE.test(meta)) return null

  const address = getAddress(raw)

  // Display name is best-effort: the token already identifies the recipient.
  let displayName = shortAddress(address)
  try {
    const { data: profile } = await supabase
      .from('profiles').select('handle').eq('address', address).maybeSingle()
    if (profile?.handle) displayName = profile.handle
  } catch {
    // Non-critical: fall back to the shortened address.
  }

  return { recipient: { address, displayName }, metaAddress: meta as `0x${string}` }
}

export async function resolveRecipient(identifier: string): Promise<Recipient | null> {
  if (isAddress(identifier)) {
    const address = getAddress(identifier)

    // Profile lookup is optional - fall back to address display on any DB failure
    let displayName = shortAddress(address)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('handle')
        .eq('address', address)
        .maybeSingle()
      if (!error && data?.handle) displayName = data.handle
    } catch {
      // Non-critical: address already known, profile display is best-effort
    }

    return { address, displayName }
  }

  // Handle lookup is critical - must succeed or we can't identify the recipient
  const { data, error } = await supabase
    .from('profiles')
    .select('address, handle')
    .eq('handle', identifier.toLowerCase())
    .maybeSingle()

  if (error) throw new Error(`Profile lookup failed: ${error.message}`)
  if (!data) return null
  if (!isAddress(data.address)) return null  // guard against corrupted DB row

  return {
    address:     getAddress(data.address),
    displayName: data.handle ?? identifier,
  }
}

// Validated from the single shared definition so the register (write) and pay
// (read) paths can never drift: a malformed meta-address feeds stealth-address
// derivation and would route funds somewhere the recipient cannot spend from.


// Look up the recipient's published stealth meta-address, if any. Best-effort:
// any failure resolves to null so the caller can degrade to the public form.
export async function lookupStealthMeta(address: `0x${string}`): Promise<`0x${string}` | null> {
  try {
    const { data, error } = await supabase
      .from('stealth_meta').select('meta_address').eq('address', address).maybeSingle()
    if (error || !data) return null
    const meta: unknown = data.meta_address
    if (typeof meta !== 'string' || !META_ADDRESS_RE.test(meta)) return null
    return meta as `0x${string}`
  } catch {
    return null
  }
}

// The stealth pay form is only usable when the gateway is deployed/configured.
export function stealthGatewayConfigured(): boolean {
  const g = process.env.NEXT_PUBLIC_STEALTH_GATEWAY
  return !!g && isAddress(g)
}
