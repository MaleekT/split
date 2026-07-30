'use client'

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http } from 'viem'
import { arcTestnet } from './chain'
import { ARC_RPC_URLS } from './rpc-endpoints'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
if (!projectId) throw new Error('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set')

export const wagmiConfig = getDefaultConfig({
  appName: 'Split',
  projectId,
  chains: [arcTestnet],
  // Without this, getDefaultConfig builds its own transport from
  // arcTestnet.rpcUrls.default.http[0] and silently ignores NEXT_PUBLIC_ARC_RPC.
  // That is why hook reads (useReadContracts) kept hitting Arc's rate-limited
  // public RPC and reporting "Failed to fetch" while publicClient - which does
  // read the env var - was working on the same page. Both now share one ordered
  // fallback list, so configuring the endpoint actually configures everything.
  transports: {
    [arcTestnet.id]: fallback(ARC_RPC_URLS.map((url) => http(url)), { rank: false }),
  },
  ssr: true,
})
