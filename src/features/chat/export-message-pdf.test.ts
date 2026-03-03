import { describe, expect, it } from "bun:test"
import { buildConversationPdfFileName } from "./export-message-pdf"

describe("buildConversationPdfFileName", () => {
  it("builds title-round format", () => {
    expect(buildConversationPdfFileName("京都古都魅力之旅", 3)).toBe("京都古都魅力之旅-3.pdf")
  })

  it("falls back to default title and round", () => {
    expect(buildConversationPdfFileName("   ", 0)).toBe("新对话-1.pdf")
  })

  it("replaces filesystem-invalid characters in title", () => {
    expect(buildConversationPdfFileName('A/B:C*D?"E', 2)).toBe("A_B_C_D__E-2.pdf")
  })
})
