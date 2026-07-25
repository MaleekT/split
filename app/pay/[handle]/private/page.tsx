import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { StealthPayForm } from '../stealth-pay-form'
import { resolveRecipient, lookupStealthMeta, stealthGatewayConfigured } from '@/lib/pay-recipient'

interface Props {
  params: Promise<{ handle: string }>
}

// Matches the standalone dark treatment the other /pay surfaces use, and the
// repo's server-component styling convention (module CSS + dangerouslySetInnerHTML).
const PAGE_CSS = `
.sp-unavail-cta {
  display: block;
  margin-top: 24px;
  height: 48px;
  line-height: 48px;
  border-radius: 14px;
  text-decoration: none;
  font-size: 15px;
  font-weight: 700;
  background: linear-gradient(135deg, #12A971 0%, #16C784 100%);
  color: #04110B;
  transition: transform 140ms ease, filter 140ms ease;
}
.sp-unavail-cta:hover { filter: brightness(1.07); transform: translateY(-1px); }
.sp-unavail-cta:active { transform: translateY(0); filter: brightness(0.96); }
.sp-unavail-cta:focus-visible { outline: 2px solid #16C784; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
  .sp-unavail-cta { transition: none; }
  .sp-unavail-cta:hover, .sp-unavail-cta:active { transform: none; }
}
`

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle: identifier } = await params
  const recipient = await resolveRecipient(identifier)
  const display   = recipient?.displayName ?? identifier
  return {
    title:       `Pay ${display} privately · Split`,
    description: `Send USDC privately to ${display} via Split.`,
    // A private pay link should not be indexed.
    robots: { index: false, follow: false },
  }
}

// The PRIVATE pay link. Pays a fresh one-time stealth address that only the
// recipient can detect and spend from.
//
// If privacy is unavailable this page NEVER quietly falls back to a public
// transfer: a payer who opened a private link and got a public payment would be
// deanonymising the recipient while believing the opposite. It says so instead
// and makes the public link an explicit, deliberate choice.
export default async function PrivatePayPage({ params }: Props) {
  const { handle: identifier } = await params
  const recipient = await resolveRecipient(identifier)
  if (!recipient) notFound()

  const metaAddress = stealthGatewayConfigured()
    ? await lookupStealthMeta(recipient.address)
    : null

  if (!metaAddress) {
    return <PrivacyUnavailable handle={identifier} displayName={recipient.displayName} />
  }

  return (
    <StealthPayForm
      recipientAddress={recipient.address}
      displayName={recipient.displayName}
      metaAddress={metaAddress}
    />
  )
}

function PrivacyUnavailable({ handle, displayName }: { handle: string; displayName: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#07090F' }}>
      <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      <div style={{ width: '100%', maxWidth: 420, background: 'linear-gradient(180deg,rgba(18,20,32,.95) 0%,rgba(11,13,22,.98) 100%)', border: '1px solid rgba(255,255,255,.08)', borderRadius: 32, padding: 40, textAlign: 'center', boxShadow: '0px 20px 60px rgba(0,0,0,.45)' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(139,124,246,.1)', border: '1px solid rgba(139,124,246,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#8B7CF6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19.69 14a6.9 6.9 0 0 0 .31-2V5l-8-3-3.16 1.18" />
            <path d="M4.73 4.73 4 5v7c0 6 8 10 8 10a20.3 20.3 0 0 0 5.62-4.38" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        </div>

        <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: '0 0 8px' }}>
          Private payments aren&apos;t on
        </p>
        <p style={{ fontSize: 15, color: 'rgba(255,255,255,.5)', margin: 0, lineHeight: 1.5 }}>
          <span style={{ color: '#fff', fontWeight: 600 }}>{displayName}</span> hasn&apos;t turned on
          private payments, so there&apos;s no private address to pay.{' '}
          <span style={{ color: 'rgba(255,255,255,.75)' }}>Nothing was sent.</span>
        </p>

        <Link href={`/pay/${encodeURIComponent(handle)}`} className="sp-unavail-cta">
          Pay normally instead
        </Link>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,.3)', marginTop: 12, lineHeight: 1.5 }}>
          A normal payment is publicly visible on-chain.
        </p>
      </div>
    </div>
  )
}
