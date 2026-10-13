export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="brand-mark"
      fill="none"
      height={size}
      viewBox="0 0 40 40"
      width={size}
    >
      <path d="M20 2 31 13H9L20 2Z" fill="var(--brand-red)" />
      <path d="M5 15h30v6H25l-5 5-5-5H5v-6Z" fill="var(--brand-ink)" />
      <path d="M8 22h6v14H8zM26 22h6v14h-6z" fill="var(--brand-ink)" />
      <path d="m2 23 5 1-3 12H0l2-13ZM38 23l-5 1 3 12h4l-2-13Z" fill="var(--brand-sand)" />
      <path
        d="m15.5 28 3.2 3.2 6.5-7"
        stroke="var(--brand-teal)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3.2"
      />
    </svg>
  );
}

export function BrandLockup() {
  return (
    <span className="brand-lockup">
      <BrandMark />
      <span className="brand-wordmark">
        egy<span className="brand-hyphen">-</span>pay
      </span>
    </span>
  );
}
