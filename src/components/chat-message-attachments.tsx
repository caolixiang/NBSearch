import fileLightIcon from "@/assets/file-light.svg"
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

function resolveAttachmentExtension(fileName: string): string {
  return fileName.split(".").pop()?.trim().toLowerCase() || ""
}

function resolveAttachmentBadge(fileName: string): { label: string; ariaLabel: string } {
  const ext = resolveAttachmentExtension(fileName)
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    if (ext === "csv") return { label: "CSV", ariaLabel: "CSV 文件" }
    if (ext === "tsv") return { label: "TSV", ariaLabel: "TSV 文件" }
    if (ext === "ods") return { label: "ODS", ariaLabel: "ODS 文件" }
    return { label: "XLS", ariaLabel: "Excel 文件" }
  }
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    if (ext === "pdf") return { label: "PDF", ariaLabel: "PDF 文件" }
    if (ext === "txt") return { label: "TXT", ariaLabel: "TXT 文件" }
    if (ext === "md") return { label: "MD", ariaLabel: "Markdown 文件" }
    if (ext === "pages") return { label: "DOC", ariaLabel: "文档文件" }
    return { label: "DOC", ariaLabel: "文档文件" }
  }
  if (CODE_TEXT_EXTENSIONS.has(ext)) {
    if (ext === "yaml" || ext === "yml") return { label: "YML", ariaLabel: "YAML 文件" }
    if (ext === "json") return { label: "JSON", ariaLabel: "JSON 文件" }
    if (ext === "xml") return { label: "XML", ariaLabel: "XML 文件" }
    if (ext === "toml") return { label: "TOML", ariaLabel: "TOML 文件" }
    if (ext === "ini") return { label: "INI", ariaLabel: "INI 文件" }
    return { label: "LOG", ariaLabel: "日志文件" }
  }
  if (ext) {
    return { label: ext.toUpperCase().slice(0, 4), ariaLabel: `${ext.toUpperCase()} 文件` }
  }
  return { label: "FILE", ariaLabel: "文件" }
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
          <div className={cn("flex w-full flex-col items-end gap-2", text ? "pt-0.5" : "")}>
            {attachments.map((fileName, index) => {
              const badge = resolveAttachmentBadge(fileName)
              return (
                <div
                  key={`${fileName}-${index}`}
                  className="flex w-fit max-w-full items-center gap-3 rounded-[24px] border border-border/80 bg-background px-4 py-3 text-[15px] leading-6 text-foreground shadow-[0_1px_0_rgba(0,0,0,0.02)] sm:min-w-[20rem] sm:px-5 sm:py-3.5"
                >
                  <figure
                    className="-ms-1 grid aspect-square w-12 shrink-0 place-items-center bg-center bg-no-repeat"
                    style={{ backgroundImage: `url(${fileLightIcon})` }}
                  >
                    <span
                      className="w-auto text-center text-[8px] font-semibold tracking-[0.04em] text-muted-foreground"
                      aria-label={badge.ariaLabel}
                    >
                      {badge.label}
                    </span>
                  </figure>
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
