import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { PayForm } from './pay-form'
import { StealthPayForm } from './stealth-pay-form'
import { resolveRecipient, resolveLinkToken, stealthGatewayConfigured } from '@/lib/pay-recipient'
import { isLinkToken } from '@/lib/stealth-link'

interface Props {
  params: Promise<{ handle: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle: identifier } = await params
  // Private links carry no recipient name in their metadata and are not indexed:
  // a link preview naming the recipient would undo the point of the opaque URL.
  if (isLinkToken(identifier)) {
    return { title: 'Pay · Split', description: 'Send USDC via Split.', robots: { index: false, follow: false } }
  }
  const recipient = await resolveRecipient(identifier)
  const display   = recipient?.displayName ?? identifier
  return {
    title:       `Pay ${display} · Split`,
    description: `Send USDC to ${display} via Split.`,
  }
}

// One route serves both links so their URLs are the same shape and a payer
// cannot tell them apart:
//
//   /pay/{handle}  -> always a normal, publicly visible transfer
//   /pay/{token}   -> a one-time stealth address (24-hex opaque token)
//
// Enabling privacy never changes what the handle link does; the recipient
// chooses which link to share. A token is 24 hex chars and HANDLE_RE caps
// handles at 20, so the two namespaces cannot collide.
export default async function PayPage({ params }: Props) {
  const { handle: identifier } = await params

  if (isLinkToken(identifier)) {
    // Fails closed: an unknown, revoked, or not-yet-configured token 404s rather
    // than quietly falling back to a public payment, which would deanonymise the
    // recipient while the payer believed the opposite.
    if (!stealthGatewayConfigured()) notFound()
    const resolved = await resolveLinkToken(identifier)
    if (!resolved) notFound()
    return (
      <StealthPayForm
        recipientAddress={resolved.recipient.address}
        displayName={resolved.recipient.displayName}
        metaAddress={resolved.metaAddress}
      />
    )
  }

  const recipient = await resolveRecipient(identifier)
  if (!recipient) notFound()

  return (
    <PayForm
      recipientAddress={recipient.address}
      displayName={recipient.displayName}
    />
  )
}
