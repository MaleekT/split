import { createPublicClient, fallback, http } from 'viem'
import { arcTestnet } from './chain'
import { ARC_RPC_URLS } from './rpc-endpoints'

export const publicClient = createPublicClient({
  chain: arcTestnet,
  // Fallback rather than a single endpoint. Arc's public RPC rate-limits bursts
  // and intermittently drops connections, which surfaces in the browser as
  // "Failed to fetch" and previously took a whole balance read down with it.
  // viem tries each endpoint in order and moves on when one errors, so a single
  // unhealthy provider degrades speed instead of breaking the page.
  transport: fallback(ARC_RPC_URLS.map((url) => http(url)), { rank: false }),
})
