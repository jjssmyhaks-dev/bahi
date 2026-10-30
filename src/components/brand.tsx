export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect width="26" height="26" rx="8" className="fill-foreground" />
      <path
        d="M7.5 9.5h8M7.5 13h5"
        stroke="var(--color-background)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="m9 18 2.6 2.6L18.5 13"
        stroke="var(--color-background)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="text-lg font-semibold tracking-tight">Bahi</span>
    </span>
  );
}
