'use client'

import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { arcTestnet } from './chain'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
if (!projectId) throw new Error('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set')

export const wagmiConfig = getDefaultConfig({
  appName: 'Split',
  projectId,
  chains: [arcTestnet],
  ssr: true,
})
