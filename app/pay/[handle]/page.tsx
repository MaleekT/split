import { notFound } from 'next/navigation'
import { isAddress, getAddress } from 'viem'
import type { Metadata } from 'next'
import { supabase } from '@/lib/supabase'
import { shortAddress } from '@/lib/format'
import { PayForm } from './pay-form'

interface Props {
  params: Promise<{ handle: string }>
}

interface Recipient {
  address:     `0x${string}`
  displayName: string
}

async function resolveRecipient(identifier: string): Promise<Recipient | null> {
  if (isAddress(identifier)) {
    const address = getAddress(identifier)

    // Profile lookup is optional — fall back to address display on any DB failure
    let displayName = shortAddress(address)
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('handle')
        .eq('address', address)
        .maybeSingle()
      if (!error && data?.handle) displayName = data.handle
    } catch {
      // Non-critical: address already known, profile display is best-effort
    }

    return { address, displayName }
  }

  // Handle lookup is critical — must succeed or we can't identify the recipient
  const { data, error } = await supabase
    .from('profiles')
    .select('address, handle')
    .eq('handle', identifier.toLowerCase())
    .maybeSingle()

  if (error) throw new Error(`Profile lookup failed: ${error.message}`)
  if (!data) return null
  if (!isAddress(data.address)) return null  // guard against corrupted DB row

  return {
    address:     getAddress(data.address),
    displayName: data.handle ?? identifier,
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle: identifier } = await params
  const recipient = await resolveRecipient(identifier)
  const display   = recipient?.displayName ?? identifier
  return {
    title:       `Pay ${display} · Split`,
    description: `Send USDC to ${display} via Split.`,
  }
}

export default async function PayPage({ params }: Props) {
  const { handle: identifier } = await params
  const recipient = await resolveRecipient(identifier)
  if (!recipient) notFound()

  return (
    <PayForm
      recipientAddress={recipient.address}
      displayName={recipient.displayName}
    />
  )
}
