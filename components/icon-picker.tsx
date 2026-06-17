'use client'

import { BUCKET_ICON_SLUGS, BUCKET_ICONS } from './bucket-icon'

export function IconPicker({ value, onChange }: { value: string; onChange: (slug: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-1.5">
      {BUCKET_ICON_SLUGS.map((slug) => {
        const Icon = BUCKET_ICONS[slug]!
        const active = value === slug
        return (
          <button
            key={slug}
            type="button"
            onClick={() => onChange(slug)}
            aria-label={slug}
            aria-pressed={active}
            className="flex items-center justify-center transition-colors"
            style={{
              aspectRatio: '1 / 1',
              borderRadius: 8,
              border: active ? '1px solid var(--accent)' : '0.5px solid var(--border)',
              background: active ? 'var(--accent-bg)' : 'var(--bg-3)',
              color: active ? 'var(--accent)' : 'var(--text-2)',
            }}
          >
            <Icon size={16} />
          </button>
        )
      })}
    </div>
  )
}
