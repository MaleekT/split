'use client'

import { useMemo } from 'react'
import { useAccount, useReadContracts } from 'wagmi'
import { USDC, erc20Abi, ZERO_ADDRESS, type SplitBucket } from '@/lib/contracts'
import { formatUsdc } from '@/lib/format'
import { useStealth } from '@/hooks/use-stealth'
import type { GeneratedBucketWallet } from '@/hooks/use-bucket-wallets'

// Total Balance: everything the app can see, with a breakdown separating what the
// user provably controls from what has already been paid out to an external
// address.
//
// Two things it deliberately does NOT do:
//
// 1. It never includes unclaimed private payments. Those sit at stealth addresses
//    whose whole purpose is being unlinkable to this user; summing them into a
//    headline figure would render the amount beside their public identity. They
//    stay on the Privacy page, behind the local scan.
//
// 2. It never counts an unknown balance as zero. A locked Vault has an unknown
//    balance, not an empty one, and quietly substituting 0 would show a confident
//    total that is wrong - the reading most likely to make someone think funds
//    have gone missing.

interface Props {
  buckets:   readonly SplitBucket[]
  /** Sum of bucket balances held inside the Split contract. */
  holdTotal: bigint
  generated: readonly GeneratedBucketWallet[]
  mask:      (v: string) => string
}

export function TotalBalanceCard({ buckets, holdTotal, generated, mask }: Props) {
  const { address } = useAccount()
  const stealth     = useStealth()

  // Unique external destinations. A bucket paying out to an address the user does
  // not control is still money the app can see, but it is not theirs any more.
  const destinations = useMemo(() => {
    const seen = new Map<string, `0x${string}`>()
    for (const b of buckets) {
      if (b.destination === ZERO_ADDRESS) continue
      seen.set(b.destination.toLowerCase(), b.destination)
    }
    return [...seen.values()]
  }, [buckets])

  const generatedSet = useMemo(
    () => new Set(generated.map((g) => g.walletAddress.toLowerCase())),
    [generated],
  )

  // The Vault is only readable once unlocked this session, because its address is
  // derived client-side and never stored. Reading a known address costs no
  // signature; we simply do not ask when it is still locked.
  const vaultAddress = stealth.vaultAddress
  const addresses    = useMemo(
    () => (vaultAddress ? [...destinations, vaultAddress] : destinations),
    [destinations, vaultAddress],
  )

  const { data } = useReadContracts({
    contracts: addresses.map((a) => ({
      address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a],
    } as const)),
    query: { enabled: addresses.length > 0, refetchInterval: 30_000 },
  })

  // All derived, no state: a failed read is a fact about the current data, so
  // deriving it keeps render pure and avoids a state write during render.
  const { yours, external, vaultRaw, failedReads } = useMemo(() => {
    let yoursSum = holdTotal
    let externalSum = 0n
    let vault: bigint | null = null
    let failed = 0

    addresses.forEach((a, i) => {
      const res = data?.[i]
      if (!res || res.status !== 'success' || typeof res.result !== 'bigint') { failed++; return }
      const bal = res.result
      if (vaultAddress && a.toLowerCase() === vaultAddress.toLowerCase()) {
        vault = bal
        yoursSum += bal
      } else if (generatedSet.has(a.toLowerCase())) {
        yoursSum += bal
      } else {
        externalSum += bal
      }
    })

    return { yours: yoursSum, external: externalSum, vaultRaw: vault, failedReads: failed }
  }, [addresses, data, holdTotal, vaultAddress, generatedSet])

  // Complete only when nothing is unknown: the Vault is unlocked AND every balance
  // read succeeded. Otherwise the figure is explicitly labelled partial rather
  // than presented as a total.
  const vaultKnown = vaultAddress !== null && vaultRaw !== null
  const isPartial  = !vaultKnown || failedReads > 0

  if (!address) return null

  return (
    <div style={{ padding: '14px 16px', borderRadius: 16, background: 'var(--bg-2)', border: '0.5px solid var(--border)' }}>
      <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 500, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-2)' }}>
        Total Balance
      </p>

      <p style={{ marginTop: 4, fontSize: 26, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
        {mask(formatUsdc(yours + external))}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)' }}> USDC</span>
      </p>

      {isPartial && (
        <p role="status" style={{ marginTop: 4, fontSize: 11.5, lineHeight: 1.5, color: 'var(--warning, #FBBF24)' }}>
          {!vaultKnown
            ? 'Partial: your Private Vault is locked, so its balance is not counted yet. Open it on the Privacy page to include it.'
            : 'Partial: some balances could not be read just now.'}
        </p>
      )}

      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Row label="Yours" hint="Held in Split, your Vault, and wallets Split generated" value={mask(formatUsdc(yours))} strong />
        <Row label="Sent to external addresses" hint="Buckets paying out to an address you added yourself" value={mask(formatUsdc(external))} />
      </div>

      <p style={{ marginTop: 8, fontSize: 11, lineHeight: 1.5, color: 'var(--text-3)' }}>
        Unclaimed private payments are not included. They stay on the Privacy page,
        where only you can see them.
      </p>
    </div>
  )
}

function Row({ label, hint, value, strong = false }: {
  label: string; hint: string; value: string; strong?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: strong ? 700 : 500, color: strong ? 'var(--text)' : 'var(--text-2)' }}>{label}</span>
        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-3)', lineHeight: 1.4 }}>{hint}</span>
      </span>
      <span className="font-mono" style={{ fontSize: 13, fontWeight: strong ? 700 : 500, color: strong ? 'var(--text)' : 'var(--text-2)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}
