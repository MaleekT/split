'use client'

import { useReadContracts } from 'wagmi'
import { USDC, erc20Abi } from '@/lib/contracts'
import { useStealth } from '@/hooks/use-stealth'

/**
 * The sum of the amounts shown on the user's bucket cards, plus the Private Vault.
 * Hold buckets contribute their current contract balance; destination buckets
 * contribute their per-bucket cumulative routed amount before this hook is called.
 *
 * It deliberately EXCLUDES unclaimed private payments. Those sit at stealth
 * addresses whose whole purpose is being unlinkable to this user, and summing them
 * into a dashboard figure would render the amount beside their public identity.
 * They stay on the Privacy page, behind the local scan.
 */
export interface SplitTotal {
  /** Sum of displayed bucket amounts + Vault. */
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

export function useSplitTotal(bucketTotal: bigint, bucketTotalPartial = false): SplitTotal {
  const stealth = useStealth()

  // The Vault address is derived client-side and never stored, so it is only known
  // once unlocked this session. Reading a known address costs no signature; we
  // simply cannot ask while it is locked.
  const vaultAddress = stealth.vaultAddress

  const { data } = useReadContracts({
    contracts: vaultAddress ? [{
      address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [vaultAddress],
    } as const] : [],
    query: {
      enabled: vaultAddress !== null,
      refetchInterval: 30_000,
      // Arc's public RPC rate-limits concurrent reads: at 25 in flight it returns
      // HTTP 429 for roughly a third and drops the odd connection outright, which
      // surfaces in the browser as "Failed to fetch". A dashboard load issues far
      // more reads than it used to, so retry the throttled ones with backoff
      // instead of immediately declaring the total partial over a transient blip.
      retry: 3,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
    },
  })

  const vaultResult = data?.[0]
  const vaultReadable = vaultResult?.status === 'success' && typeof vaultResult.result === 'bigint'
  const vaultBalance = vaultReadable ? vaultResult.result as bigint : 0n

  // A locked Vault is an unknown balance, not an empty one. Treating it as zero
  // would show a confident total that is quietly wrong.
  const vaultLocked = vaultAddress === null
  const vaultReadFailed = vaultAddress !== null && !vaultReadable
  return {
    total: bucketTotal + vaultBalance,
    isPartial: bucketTotalPartial || vaultLocked || vaultReadFailed,
    vaultLocked,
  }
}
