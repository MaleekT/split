import { AppShell } from './app-shell'

// Wallet-gated client routes — render on demand, never statically prerender at build.
// Cascades to all nested /app/* segments (dashboard, settings, profile).
export const dynamic = 'force-dynamic'

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
