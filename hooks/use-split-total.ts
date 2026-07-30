'use client'

import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { USDC, erc20Abi, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { useStealth } from '@/hooks/use-stealth'

/**
 * Everything Split is currently accounting for: funds held in the contract, the
 * Private Vault, and the live balance of every wallet-bucket destination.
 *
 * Generated and manually-added destinations count identically. This figure is
 * "what Split has processed and is tracking", not a personal net-worth number, so
 * a bucket paying out to someone else's address still belongs in it.
 *
 * It deliberately EXCLUDES unclaimed private payments. Those sit at stealth
 * addresses whose whole purpose is being unlinkable to this user, and summing them
 * into a dashboard figure would render the amount beside their public identity.
 * They stay on the Privacy page, behind the local scan.
 */
export interface SplitTotal {
  /** Hold-in-contract + Vault + all wallet-bucket destinations. */
  total: bigint
  /**
   * True when at least one component could not be read, so `total` is a floor
   * rather than the real figure. Callers must say so instead of presenting the
   * number as complete - silently understating it is the bug this exists to stop.
   */
  isPartial: boolean
  /** The Vault is the specific thing missing (locked, so its balance is unknown). */
  vaultLocked: boolean
}

export function useSplitTotal(buckets: readonly SplitBucket[], holdTotal: bigint): SplitTotal {
  const stealth = useStealth()

  // Unique non-hold destinations. Deduplicated because two buckets may legitimately
  // pay the same address, and its balance must not be counted twice.
  const destinations = useMemo(() => {
    const seen = new Map<string, `0x${string}`>()
    for (const b of buckets) {
      if (b.destination === ZERO_ADDRESS) continue
      seen.set(b.destination.toLowerCase(), b.destination)
    }
    return [...seen.values()]
  }, [buckets])

  // The Vault address is derived client-side and never stored, so it is only known
  // once unlocked this session. Reading a known address costs no signature; we
  // simply cannot ask while it is locked.
  const vaultAddress = stealth.vaultAddress
  const addresses = useMemo(
    () => (vaultAddress ? [...destinations, vaultAddress] : destinations),
    [destinations, vaultAddress],
  )

  const { data } = useReadContracts({
    contracts: addresses.map((a) => ({
      address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a],
    } as const)),
    query: { enabled: addresses.length > 0, refetchInterval: 30_000 },
  })

  return useMemo(() => {
    let sum = holdTotal
    let failed = 0

    addresses.forEach((_, i) => {
      const res = data?.[i]
      if (!res || res.status !== 'success' || typeof res.result !== 'bigint') { failed++; return }
      sum += res.result
    })

    // A locked Vault is an unknown balance, not an empty one. Treating it as zero
    // would show a confident total that is quietly wrong.
    const vaultLocked = vaultAddress === null
    return { total: sum, isPartial: vaultLocked || failed > 0, vaultLocked }
  }, [addresses, data, holdTotal, vaultAddress])
}
