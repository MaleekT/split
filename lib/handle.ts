// 3–20 chars, a–z / 0–9 / hyphens / underscores, must start and end with alphanumeric
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$/

export function isValidHandle(s: string): boolean {
  return HANDLE_RE.test(s)
}
