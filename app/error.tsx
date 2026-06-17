'use client'

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.error('[GlobalError]', error)
    }
  }, [error])

  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col items-center justify-center px-6 bg-[#f5f5f4]">
        <div className="max-w-sm w-full text-center space-y-4">
          <h2 className="text-lg font-semibold text-[#111110]">Something went wrong</h2>
          <p className="text-sm text-[#6f6e69]">Please try again or reload the page.</p>
          <button
            type="button"
            onClick={reset}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-[#111110] hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D9E75] focus-visible:ring-offset-2 transition-opacity"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
