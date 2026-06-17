'use client'

import { useQuery } from '@tanstack/react-query'
import { isAddress } from 'viem'

// bucketId (as string) → cumulative routed amount (raw 6-decimal USDC, as string)
export type RoutedTotals = Record<string, string>

/**
 * Cumulative USDC the Split contract has forwarded to each destination bucket's wallet,
 * summed live from on-chain BucketSplit events via /api/buckets/routed.
 */
export function useRoutedTotals(address: string | undefined) {
  return useQuery<RoutedTotals>({
    queryKey: ['routed', address],
    queryFn: async () => {
      if (!address || !isAddress(address)) throw new Error('Invalid address')
      const res = await fetch(`/api/buckets/routed/${encodeURIComponent(address)}`)
      if (!res.ok) throw new Error(`Failed to load routed totals (HTTP ${res.status})`)
      const json = (await res.json()) as { data: RoutedTotals }
      return json.data
    },
    enabled: !!address && isAddress(address),
    refetchInterval: 30_000,
    staleTime: 20_000,
  })
}
