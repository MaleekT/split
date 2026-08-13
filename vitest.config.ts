import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Frontend tests for the locked-bucket UI.
//
// This repo had no test runner before this feature. It is added because the
// states these tests cover are financially misleading if they render wrongly: a
// lock owned by somebody else must never look like the user's own, and a bucket
// mid-migration must never claim to be locked while its money is still
// withdrawable from Split. Visual inspection is not an adequate gate for that.
//
// Scope is deliberately narrow: pure rendering of the classification states.
// Contract behaviour is covered by Foundry, and the arithmetic by node --test
// against lib/lock.ts, so nothing is duplicated here.
export default defineConfig({
  // No @vitejs/plugin-react on purpose. Its only contribution here would be Fast
  // Refresh, which tests never use, and plugin-react 6 requires vite ^8 while
  // vitest 3 caps at vite ^7 - a version conflict bought for nothing.
  //
  // The transform it would have provided is set directly instead: the repo's
  // tsconfig uses `jsx: preserve` for Next's own compiler, which leaves esbuild
  // on the classic runtime and fails with "React is not defined".
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['components/__tests__/**/*.test.tsx', 'lib/**/*.test.ts'],
  },
})
