import { createPublicClient, http } from 'viem'
import { arcTestnet } from './chain'

const rpcUrl = process.env.NEXT_PUBLIC_ARC_RPC
if (!rpcUrl) throw new Error('NEXT_PUBLIC_ARC_RPC is not configured')

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(rpcUrl),
})
