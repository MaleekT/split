'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { LayoutDashboard, Wallet, Activity, User, Headphones, Menu, X, ChevronDown, HelpCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SplitLogo } from '@/components/brand/logo'
import { ThemeToggle } from '@/components/theme-toggle'

const NAV: { href: string; label: string; icon: LucideIcon; exact: boolean }[] = [
  { href: '/app',          label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/app/settings', label: 'Buckets',   icon: Wallet,          exact: false },
  { href: '/app/activity', label: 'Activity',  icon: Activity,        exact: false },
  { href: '/app/profile',  label: 'Profile',   icon: User,            exact: false },
]

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav aria-label="Main navigation" className="flex flex-col" style={{ gap: 4 }}>
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className="flex items-center gap-3 transition-colors"
            style={{
              padding: '9px 12px',
              borderRadius: 10,
              fontFamily: "'Inter', sans-serif",
              fontWeight: active ? 600 : 500,
              fontSize: 14,
              color: active ? 'var(--accent)' : 'var(--text-2)',
              background: active ? 'var(--accent-bg)' : 'transparent',
            }}
          >
            <Icon size={18} />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}

function UserBlock() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, mounted }) => {
        if (!mounted) return null
        if (!account || !chain) {
          return (
            <button
              type="button"
              onClick={openConnectModal}
              className="w-full text-white transition-opacity hover:opacity-90"
              style={{ background: 'var(--accent)', borderRadius: 10, padding: '10px 12px', fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 13 }}
            >
              Connect wallet
            </button>
          )
        }
        return (
          <button
            type="button"
            onClick={openAccountModal}
            className="w-full flex items-center gap-2.5 transition-colors hover:bg-[var(--bg-3)]"
            style={{ borderRadius: 10, padding: '8px 10px', border: '0.5px solid var(--border)' }}
          >
            <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 999, flexShrink: 0, background: 'linear-gradient(135deg, var(--accent), #60A5FA)' }} />
            <span className="min-w-0 flex-1 text-left font-mono truncate" style={{ fontSize: 13, color: 'var(--text)' }}>
              {account.displayName}
            </span>
            <ChevronDown size={15} color="var(--text-3)" />
          </button>
        )
      }}
    </ConnectButton.Custom>
  )
}

function SidebarInner({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex flex-col h-full" style={{ padding: 16 }}>
      <Link href="/" aria-label="Split — home" className="flex items-center" style={{ padding: '4px 8px', marginBottom: 20 }}>
        <SplitLogo size={28} />
      </Link>

      <NavList onNavigate={onNavigate} />

      <div className="flex-1" />

      <div className="flex flex-col" style={{ gap: 12 }}>
        <ThemeToggle />
        <UserBlock />
        <div className="flex items-center gap-2.5" style={{ background: 'var(--bg-3)', borderRadius: 10, padding: '10px 12px' }}>
          <Headphones size={18} color="var(--accent)" />
          <div>
            <p style={{ fontFamily: "'Inter', sans-serif", fontWeight: 600, fontSize: 12, color: 'var(--text)' }}>Need help?</p>
            <p style={{ fontSize: 11, color: 'var(--text-2)' }}>Contact support</p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { isConnected, isConnecting } = useAccount()
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="min-h-screen md:flex" style={{ background: 'var(--bg)' }}>
      {/* Desktop sidebar */}
      <aside className="hidden md:block shrink-0 sticky top-0 h-screen" style={{ width: 248, background: 'var(--bg-2)', borderRight: '0.5px solid var(--border)' }}>
        <SidebarInner />
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-40 flex items-center justify-between" style={{ height: 56, padding: '0 16px', background: 'var(--bg-2)', borderBottom: '0.5px solid var(--border)' }}>
        <Link href="/" aria-label="Split — home" className="flex items-center">
          <SplitLogo size={24} />
        </Link>
        <button type="button" aria-label="Open menu" onClick={() => setDrawerOpen(true)} style={{ background: 'var(--bg-3)', border: '0.5px solid var(--border)', borderRadius: 8, padding: '6px 8px', color: 'var(--text-2)' }}>
          <Menu size={18} />
        </button>
      </header>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={() => setDrawerOpen(false)} aria-hidden="true" />
          <div className="absolute top-0 left-0 h-full" style={{ width: 260, background: 'var(--bg-2)', borderRight: '0.5px solid var(--border)' }}>
            <div className="flex justify-end" style={{ padding: '12px 12px 0' }}>
              <button type="button" aria-label="Close menu" onClick={() => setDrawerOpen(false)} style={{ color: 'var(--text-2)', padding: 4 }}>
                <X size={20} />
              </button>
            </div>
            <SidebarInner onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {isConnecting ? (
          <main className="flex items-center justify-center min-h-[60vh]">
            <p className="text-sm" style={{ color: 'var(--text-3)' }}>Connecting…</p>
          </main>
        ) : !isConnected ? (
          <main className="flex flex-col items-center justify-center min-h-[70vh] gap-4 px-4 text-center">
            <p className="text-base font-medium" style={{ color: 'var(--text)' }}>Connect your wallet to continue</p>
            <p className="text-sm max-w-xs" style={{ color: 'var(--text-2)' }}>Split works with any EVM wallet on Arc Testnet.</p>
            <ConnectButton />
          </main>
        ) : (
          <>
            <main style={{ padding: 24 }}>{children}</main>
            <footer className="flex items-center justify-center gap-4 flex-wrap" style={{ padding: '16px 24px 28px', fontSize: 12, color: 'var(--text-3)' }}>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }} />
                All systems operational
              </span>
              <span style={{ opacity: 0.5 }}>|</span>
              <span className="inline-flex items-center gap-1">
                All amounts are in USDC <HelpCircle size={13} />
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
