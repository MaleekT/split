// Bucket-type badges per SPLIT-UI-REDESIGN.md. The "Scheduled" badge is intentionally
// omitted — its data would require a new contract read, which is out of scope for this
// styling-only pass. Colors come from the design tokens in globals.css.

export type BadgeVariant = 'auto-sends' | 'holds' | 'goal'

const VARIANT: Record<BadgeVariant, { label: string; background: string; color: string }> = {
  'auto-sends': { label: '↗ Auto-sends', background: 'var(--info-bg)',    color: 'var(--info)' },
  'holds':      { label: 'Holds',        background: 'var(--bg-3)',       color: 'var(--text-2)' },
  'goal':       { label: '◎ Goal',       background: 'var(--warning-bg)', color: 'var(--warning)' },
}

export function Badge({ variant }: { variant: BadgeVariant }) {
  const v = VARIANT[variant]
  return (
    <span className="badge" style={{ background: v.background, color: v.color }}>
      {v.label}
    </span>
  )
}
