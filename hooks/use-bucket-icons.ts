'use client'

import { useQuery } from '@tanstack/react-query'
import { isAddress } from 'viem'

// bucketId (string) → icon slug
export type BucketIcons = Record<string, string>

export function useBucketIcons(address: string | undefined) {
  return useQuery<BucketIcons>({
    queryKey: ['bucket-icons', address],
    queryFn: async () => {
      if (!address || !isAddress(address)) throw new Error('Invalid address')
      const res = await fetch(`/api/bucket-icons?address=${encodeURIComponent(address)}`)
      if (!res.ok) throw new Error(`Failed to load bucket icons (HTTP ${res.status})`)
      const json = (await res.json()) as { data: Array<{ bucket_id: string; icon: string }> }
      const map: BucketIcons = {}
      for (const row of json.data ?? []) map[String(row.bucket_id)] = row.icon
      return map
    },
    enabled: !!address && isAddress(address),
    staleTime: 60_000,
  })
}
