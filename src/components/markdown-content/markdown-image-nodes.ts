import { Children, isValidElement, type ReactNode } from "react"

export function isAnchorImageNode(node: ReactNode): boolean {
  if (!isValidElement(node)) {
    return false
  }
  const props = node.props as { href?: unknown; children?: ReactNode }
  if (typeof props.href !== "string") {
    return false
  }
  const childNodes = Children.toArray(props.children).filter(
    (item) => !(typeof item === "string" && item.trim() === "")
  )
  return childNodes.length === 1 && isImageNode(childNodes[0])
}

export function isImageNode(node: ReactNode): boolean {
  if (!isValidElement(node)) {
    return false
  }
  const props = node.props as { src?: unknown }
  if (typeof props.src === "string" && props.src.trim() !== "") {
    return true
  }
  if (typeof node.type === "string" && node.type === "img") {
    return true
  }
  return isAnchorImageNode(node)
}

export function extractImageSource(node: ReactNode): string {
  if (!isValidElement(node)) {
    return ""
  }
  const props = node.props as { src?: unknown; children?: ReactNode }
  if (typeof props.src === "string" && props.src.trim()) {
    return props.src.trim()
  }
  for (const child of Children.toArray(props.children)) {
    const nested = extractImageSource(child)
    if (nested) {
      return nested
    }
  }
  return ""
}

function extractImageAlt(node: ReactNode): string {
  if (!isValidElement(node)) {
    return ""
  }
  const props = node.props as { alt?: unknown; children?: ReactNode }
  if (typeof props.alt === "string" && props.alt.trim()) {
    return props.alt.trim()
  }
  for (const child of Children.toArray(props.children)) {
    const nested = extractImageAlt(child)
    if (nested) {
      return nested
    }
  }
  return ""
}

export function isGeneratedImageNode(node: ReactNode): boolean {
  const alt = extractImageAlt(node).trim().toLowerCase()
  return alt === "generated image" || alt.startsWith("generated image ")
}

export function collectImageOnlyNodes(node: ReactNode): ReactNode[] | null {
  if (typeof node === "string") {
    return node.trim() ? null : []
  }
  if (node === null || node === undefined || typeof node === "boolean") {
    return []
  }

  if (isImageNode(node)) {
    return [node]
  }

  if (!isValidElement(node)) {
    return null
  }

  const props = node.props as { children?: ReactNode }
  if (props.children === undefined) {
    return null
  }

  const nested: ReactNode[] = []
  for (const child of Children.toArray(props.children)) {
    const rows = collectImageOnlyNodes(child)
    if (!rows) {
      return null
    }
    nested.push(...rows)
  }
  return nested
}

export function collectImageParagraphNodes(children: ReactNode): ReactNode[] | null {
  const rows: ReactNode[] = []
  for (const child of Children.toArray(children)) {
    const nested = collectImageOnlyNodes(child)
    if (!nested) {
      return null
    }
    rows.push(...nested)
  }
  return rows.length > 0 ? rows : null
}
