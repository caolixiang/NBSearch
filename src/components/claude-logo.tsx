import cowLogo from "@/assets/cow.svg"

export function GrokLogo({ className = "size-6" }: { className?: string }) {
  return <img src={cowLogo} alt="NBSearch" className={className} />
}

export function GrokAvatar({
  size = "md",
  className = "",
}: {
  size?: "sm" | "md" | "lg"
  className?: string
}) {
  const sizeClasses = {
    sm: "size-7",
    md: "size-8",
    lg: "size-14",
  }
  return <GrokLogo className={`shrink-0 rounded-full object-contain ${sizeClasses[size]} ${className}`} />
}
