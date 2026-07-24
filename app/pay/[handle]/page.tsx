import { notFound } from 'next/navigation'
import { isAddress, getAddress } from 'viem'
import type { Metadata } from 'next'
import { supabase } from '@/lib/supabase'
import { shortAddress } from '@/lib/format'
import { PayForm } from './pay-form'
import { StealthPayForm } from './stealth-pay-form'

interface Props {
  params: Promise<{ handle: string }>
}

interface Recipient {
  address:     `0x${string}`
  displayName: string
}

// Look up the recipient's published stealth meta-address, if any. Best-effort:
// any failure falls back to the normal (non-private) pay form.
async function lookupStealthMeta(address: `0x${string}`): Promise<`0x${string}` | null> {
  try {
    const { data, error } = await supabase
      .from('stealth_meta').select('meta_address').eq('address', address).maybeSingle()
    if (error || !data) return null
    const meta = data.meta_address as string | undefined
    return meta && /^0x[0-9a-fA-F]{130,264}$/.test(meta) ? (meta as `0x${string}`) : null
  } catch {
    return null
  }
}

// The stealth pay form is only usable when the gateway is deployed/configured.
function stealthGatewayConfigured(): boolean {
  const g = process.env.NEXT_PUBLIC_STEALTH_GATEWAY
  return !!g && isAddress(g)
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

  // If the recipient has enabled private payments and the gateway is deployed,
  // render the stealth form. Non-stealth recipients keep the unchanged pay form.
  if (stealthGatewayConfigured()) {
    const metaAddress = await lookupStealthMeta(recipient.address)
    if (metaAddress) {
      return (
        <StealthPayForm
          recipientAddress={recipient.address}
          displayName={recipient.displayName}
          metaAddress={metaAddress}
        />
      )
    }
  }

  return (
    <PayForm
      recipientAddress={recipient.address}
      displayName={recipient.displayName}
    />
  )
}
