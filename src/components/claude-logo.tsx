// Grok-style logo component

export function GrokLogo({ className = "size-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Grok's stylized mark: a slashed circle with an inner arc, resembling the xAI Grok icon */}
      <circle cx="12" cy="12" r="10" />
      <line x1="4" y1="4" x2="20" y2="20" />
      <path d="M15 9.5a4 4 0 0 1 .5 5" />
    </svg>
  )
}

export function GrokAvatar({
  size = "md",
}: {
  size?: "sm" | "md" | "lg"
}) {
  const sizeClasses = {
    sm: "size-7",
    md: "size-8",
    lg: "size-14",
  }
  const iconClasses = {
    sm: "size-3.5",
    md: "size-4",
    lg: "size-7",
  }
  return (
    <div
      className={`flex items-center justify-center rounded-full bg-foreground text-background shrink-0 ${sizeClasses[size]}`}
    >
      <GrokLogo className={iconClasses[size]} />
    </div>
  )
}
