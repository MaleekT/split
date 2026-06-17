interface TxLinkProps {
  hash: string
  className?: string
}

export function TxLink({ hash, className }: TxLinkProps) {
  return (
    <a
      href={`https://testnet.arcscan.app/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono text-xs text-[var(--split-text-secondary)] hover:text-[var(--split-accent)] underline underline-offset-2 transition-colors${className ? ` ${className}` : ''}`}
    >
      {hash.slice(0, 8)}…
    </a>
  )
}
