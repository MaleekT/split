import { formatUnits, isAddress, getAddress } from 'viem'

/**
 * Format a 6-decimal USDC raw bigint to a display string with exactly 2 decimal places.
 * Matches the output standard of <UsdcAmount />.
 */
export const formatUsdc = (raw: bigint): string =>
  parseFloat(formatUnits(raw, 6)).toFixed(2)

/** Checksum-normalize an Ethereum address for Supabase storage and comparisons. */
export const checksumAddress = (addr: string): `0x${string}` => getAddress(addr)

/**
 * Shorten a valid hex address to 0x1234…abcd format for display.
 * Throws if addr is not a valid Ethereum address.
 */
export const shortAddress = (addr: string): string => {
  if (!isAddress(addr)) throw new Error(`shortAddress: invalid address "${addr}"`)
  const checksummed = getAddress(addr)
  return `${checksummed.slice(0, 6)}…${checksummed.slice(-4)}`
}
