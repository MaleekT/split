'use client'

import { useEffect, useState } from 'react'
import { Sun, Moon } from 'lucide-react'

/**
 * Segmented sun|moon pill. The `.dark` class is applied pre-hydration by the inline script
 * in the root layout, so we read the current state after mount to avoid an SSR mismatch.
 */
export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'))
  }, [])

  function setTheme(dark: boolean) {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('split-theme', dark ? 'dark' : 'light')
    setIsDark(dark)
  }

  const seg = (active: boolean) => ({
    padding: '6px 12px',
    borderRadius: 999,
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--text-2)',
  })

  return (
    <div
      className="inline-flex items-center"
      style={{ gap: 2, padding: 3, borderRadius: 999, background: 'var(--bg-3)', border: '0.5px solid var(--border)' }}
    >
      <button
        type="button"
        aria-label="Light mode"
        aria-pressed={!isDark}
        onClick={() => setTheme(false)}
        className="inline-flex items-center justify-center transition-colors"
        style={seg(!isDark)}
      >
        <Sun size={15} />
      </button>
      <button
        type="button"
        aria-label="Dark mode"
        aria-pressed={isDark}
        onClick={() => setTheme(true)}
        className="inline-flex items-center justify-center transition-colors"
        style={seg(isDark)}
      >
        <Moon size={15} />
      </button>
    </div>
  )
}
