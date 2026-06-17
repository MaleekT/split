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

  const activeStyle = (active: boolean): React.CSSProperties => ({
    background: active
      ? 'linear-gradient(135deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.03) 100%), var(--bg-2)'
      : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-2)',
    fontWeight: active ? 500 : 400,
    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.18)' : 'none',
  })

  const btnCls = 'inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-sans transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex items-center w-full gap-[2px] p-[3px] rounded-full bg-[var(--bg-3)]"
    >
      <button type="button" aria-label="Light mode" aria-pressed={!isDark} onClick={() => setTheme(false)} className={btnCls} style={activeStyle(!isDark)}>
        <Sun size={13} />
        <span>Light</span>
      </button>
      <button type="button" aria-label="Dark mode" aria-pressed={isDark} onClick={() => setTheme(true)} className={btnCls} style={activeStyle(isDark)}>
        <Moon size={13} />
        <span>Dark</span>
      </button>
    </div>
  )
}
