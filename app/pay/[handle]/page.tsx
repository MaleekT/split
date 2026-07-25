import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PayForm } from './pay-form'
import { resolveRecipient } from '@/lib/pay-recipient'

interface Props {
  params: Promise<{ handle: string }>
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

// The PUBLIC pay link. Always a normal, visible transfer - enabling private
// payments must not silently change what this link does, because the recipient
// shares it deliberately. Recipients who want a private payment share their
// separate /pay/{handle}/private link instead.
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
