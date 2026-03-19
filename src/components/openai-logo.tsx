export function OpenAILogo({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <g transform="translate(12 12)" fill="currentColor">
        <rect x="-1.7" y="-9.1" width="3.4" height="7.1" rx="1.7" />
        <rect x="-1.7" y="-9.1" width="3.4" height="7.1" rx="1.7" transform="rotate(60)" />
        <rect x="-1.7" y="-9.1" width="3.4" height="7.1" rx="1.7" transform="rotate(120)" />
        <rect x="-1.7" y="-9.1" width="3.4" height="7.1" rx="1.7" transform="rotate(180)" />
        <rect x="-1.7" y="-9.1" width="3.4" height="7.1" rx="1.7" transform="rotate(240)" />
        <rect x="-1.7" y="-9.1" width="3.4" height="7.1" rx="1.7" transform="rotate(300)" />
      </g>
      <circle cx="12" cy="12" r="2.35" fill="currentColor" />
    </svg>
  )
}
