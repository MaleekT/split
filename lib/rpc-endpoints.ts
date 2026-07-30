// Arc Testnet JSON-RPC endpoints, ordered by preference.
//
// A single endpoint proved too fragile: Arc's public RPC rate-limits concurrent
// reads (HTTP 429, and dropped connections that surface in the browser as
// "Failed to fetch"), which was enough to break a whole dashboard balance read.
// Every client uses this list through viem's fallback transport, so an unhealthy
// provider costs latency rather than taking the page down.
//
// NEXT_PUBLIC_ARC_RPC still leads the list when set, so the deployed environment
// keeps the final say. Note it is inlined at BUILD time, not read at runtime:
// changing it in the host dashboard requires a fresh deployment (with the build
// cache off) before the new value reaches the browser. The remaining entries are
// hardcoded precisely so a stale or missing env var can never leave the app with
// nowhere to talk to.

const FALLBACK_ARC_RPCS = [
  'https://arc-testnet.drpc.org',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://rpc.testnet.arc.network',
] as const

function dedupe(urls: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    const key = url.replace(/\/+$/, '')
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(url)
  }
  return out
}

/**
 * Preferred first. The configured endpoint leads when present; the known-good
 * public endpoints follow as backups. Never empty, so a client can always be
 * constructed.
 */
export const ARC_RPC_URLS: string[] = dedupe([
  ...(process.env.NEXT_PUBLIC_ARC_RPC ? [process.env.NEXT_PUBLIC_ARC_RPC] : []),
  ...FALLBACK_ARC_RPCS,
])
