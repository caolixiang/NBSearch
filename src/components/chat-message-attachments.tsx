import {
  File,
  FileCode2,
  FileSpreadsheet,
  FileText,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

const CJK_CHAR_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/
const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "ods", "csv", "tsv"])
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "odt", "pages", "txt", "rtf", "md"])
const CODE_TEXT_EXTENSIONS = new Set(["json", "xml", "yaml", "yml", "toml", "ini", "log"])

function parseUserMessageContent(content: string): { text: string; attachments: string[] } {
  const textLines: string[] = []
  const attachments: string[] = []

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*\[附件\]\s*(.+?)\s*$/)
    if (match?.[1]) {
      attachments.push(match[1])
      continue
    }
    textLines.push(line)
  }

  return {
    text: textLines.join("\n").trim(),
    attachments,
  }
}

function resolveAttachmentIcon(fileName: string): LucideIcon {
  const ext = fileName.split(".").pop()?.trim().toLowerCase() || ""
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return FileSpreadsheet
  }
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return FileText
  }
  if (CODE_TEXT_EXTENSIONS.has(ext)) {
    return FileCode2
  }
  return File
}

function characterUnits(value: string): number {
  if (!value) {
    return 0
  }
  let total = 0
  for (const char of value) {
    total += CJK_CHAR_PATTERN.test(char) ? 1 : 0.5
  }
  return total
}

function truncateAttachmentName(fileName: string, maxUnits = 20): string {
  const input = fileName.trim()
  if (!input) {
    return ""
  }
  if (characterUnits(input) <= maxUnits) {
    return input
  }

  let units = 0
  let out = ""
  for (const char of input) {
    const next = CJK_CHAR_PATTERN.test(char) ? 1 : 0.5
    if (units + next > maxUnits) {
      break
    }
    out += char
    units += next
  }

  const normalized = out.trim()
  return normalized ? `${normalized}...` : `${input.slice(0, 1)}...`
}

export function UserMessageBubble({ content }: { content: string }) {
  const { text, attachments } = parseUserMessageContent(content)
  return (
    <div className="flex justify-end px-6 py-4">
      <div className="flex max-w-[78%] flex-col items-end gap-2.5">
        {text ? (
          <div className="w-fit max-w-full rounded-[28px] rounded-br-[14px] bg-secondary px-5 py-3 text-[16px] leading-7 text-foreground">
            <p className="whitespace-pre-wrap">{text}</p>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className={cn("flex w-full flex-col items-end gap-2", text ? "pt-0.5" : "") }>
            {attachments.map((fileName, index) => {
              const Icon = resolveAttachmentIcon(fileName)
              return (
                <div
                  key={`${fileName}-${index}`}
                  className="flex w-fit max-w-full items-center gap-3 rounded-[24px] border border-border/80 bg-background px-4 py-3 text-[15px] leading-6 text-foreground shadow-[0_1px_0_rgba(0,0,0,0.02)] sm:min-w-[20rem] sm:px-5 sm:py-3.5"
                >
                  <div className="inline-flex size-11 shrink-0 items-center justify-center rounded-[18px] bg-secondary/55 text-muted-foreground">
                    <Icon className="size-5 shrink-0" />
                  </div>
                  <span className="min-w-0 max-w-[min(52vw,24rem)] overflow-hidden text-ellipsis whitespace-nowrap text-[15px] font-medium tracking-[-0.01em] text-foreground sm:max-w-[26rem]">
                    {truncateAttachmentName(fileName, 28)}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
