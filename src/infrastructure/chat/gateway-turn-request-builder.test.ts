import { describe, expect, it } from "bun:test"
import {
  buildGatewayTurnRequestPayload,
  buildUserMessageText,
} from "./gateway-turn-request-builder"

describe("buildUserMessageText", () => {
  it("appends attachment names below user text", () => {
    const text = buildUserMessageText("你好", [
      new File(["a"], "note.txt", { type: "text/plain" }),
      new File(["b"], "image.png", { type: "image/png" }),
    ])

    expect(text).toBe("你好\n\n[附件] note.txt\n[附件] image.png")
  })

  it("returns attachment lines when text is empty", () => {
    const text = buildUserMessageText("  ", [new File(["a"], "note.txt", { type: "text/plain" })])
    expect(text).toBe("[附件] note.txt")
  })
})

describe("buildGatewayTurnRequestPayload", () => {
  it("builds a standard streaming request with text and attachments", async () => {
    const payload = await buildGatewayTurnRequestPayload({
      model: "grok-4.1-fast",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      text: "分析一下",
      attachments: [
        new File(["abc"], "photo.png", { type: "image/png" }),
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ],
      anchoredSessionId: "",
      fallbackPreviousResponseId: "resp_prev_1",
    })

    expect(payload["model"]).toBe("grok-4.1-fast")
    expect(payload["session_id"]).toBe("sess_1")
    expect(payload["client_turn_id"]).toBe("turn_1")
    expect(payload["stream"]).toBe(true)
    expect(payload["previous_response_id"]).toBe("resp_prev_1")

    const inputRows = payload["input"] as Array<Record<string, unknown>>
    expect(inputRows).toHaveLength(1)
    expect(inputRows[0]?.role).toBe("user")
    const content = inputRows[0]?.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(3)
    expect(content[0]?.type).toBe("text")
    expect(content[0]?.text).toBe("分析一下")
    expect(content[1]?.type).toBe("image_url")
    expect(String((content[1]?.image_url as Record<string, unknown>).url)).toContain("data:image/png;base64,")
    expect(content[2]?.type).toBe("file")
    expect(String((content[2]?.file as Record<string, unknown>).file_data)).toContain(
      "data:text/plain"
    )
  })

  it("injects first-turn locale instructions and a per-turn time suffix when timezone is provided", async () => {
    const payload = await buildGatewayTurnRequestPayload({
      model: "grok-4.1-fast",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      text: "最近24小时发生了什么？",
      timezone: "Pacific/Honolulu",
      now: () => new Date("2026-03-10T03:44:44Z"),
    })

    expect(payload["instructions"]).toContain("<timezone>Pacific/Honolulu</timezone>")
    const inputRows = payload["input"] as Array<Record<string, unknown>>
    const content = inputRows[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe("text")
    expect(content[0]?.text).toBe(
      "最近24小时发生了什么？\n\n[Authoritative current local time for this turn only: 2026-03-09 17:44:44 Pacific/Honolulu (UTC-10:00). Ignore any earlier turn times and use this time as the reference for this turn.]"
    )
  })

  it("omits first-turn instructions when session anchor already exists but still updates the per-turn time suffix", async () => {
    const payload = await buildGatewayTurnRequestPayload({
      model: "grok-4.1-fast",
      sessionId: "sess_1",
      clientTurnId: "turn_2",
      text: "现在几点？",
      anchoredSessionId: "sess_1",
      fallbackPreviousResponseId: "resp_prev_1",
      timezone: "Pacific/Honolulu",
      now: () => new Date("2026-03-10T19:22:22Z"),
    })

    expect(payload["instructions"]).toBeUndefined()
    expect(payload["previous_response_id"]).toBeUndefined()
    const inputRows = payload["input"] as Array<Record<string, unknown>>
    const content = inputRows[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.text).toBe(
      "现在几点？\n\n[Authoritative current local time for this turn only: 2026-03-10 09:22:22 Pacific/Honolulu (UTC-10:00). Ignore any earlier turn times and use this time as the reference for this turn.]"
    )
  })

  it("omits previous_response_id when session anchor already exists", async () => {
    const payload = await buildGatewayTurnRequestPayload({
      model: "grok-4.1-fast",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      text: "继续",
      anchoredSessionId: "sess_1",
      fallbackPreviousResponseId: "resp_prev_1",
    })

    expect(payload["previous_response_id"]).toBeUndefined()
  })

  it("builds regenerate payload without user input blocks", async () => {
    const payload = await buildGatewayTurnRequestPayload({
      model: "grok-4.1-fast",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      text: "ignored",
      regenerateTargetResponseId: "resp_target_1",
      timezone: "Pacific/Honolulu",
      now: () => new Date("2026-03-10T03:44:44Z"),
    })

    expect(payload["input"]).toBeUndefined()
    expect(payload["previous_response_id"]).toBeUndefined()
    expect(payload["instructions"]).toBeUndefined()
    expect(payload["x_grok"]).toEqual({
      regenerate: true,
      target_response_id: "resp_target_1",
    })
  })

  it("injects default text when only attachments are present", async () => {
    const payload = await buildGatewayTurnRequestPayload({
      model: "grok-4.1-fast",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      text: "",
      attachments: [new File(["hello"], "notes.txt", { type: "text/plain" })],
    })

    const inputRows = payload["input"] as Array<Record<string, unknown>>
    const content = inputRows[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe("text")
    expect(content[0]?.text).toBe("请分析这个附件。")
  })

  it("keeps multiple attachments in order within a single user message", async () => {
    const payload = await buildGatewayTurnRequestPayload({
      model: "grok-4.1-fast",
      sessionId: "sess_1",
      clientTurnId: "turn_1",
      text: "一起分析",
      attachments: [
        new File(["img-1"], "photo-1.png", { type: "image/png" }),
        new File(["img-2"], "photo-2.jpg", { type: "image/jpeg" }),
        new File(["doc"], "report.pdf", { type: "application/pdf" }),
      ],
    })

    const inputRows = payload["input"] as Array<Record<string, unknown>>
    const content = inputRows[0]?.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(4)
    expect(content[0]?.type).toBe("text")
    expect(content[1]?.type).toBe("image_url")
    expect(content[2]?.type).toBe("image_url")
    expect(content[3]?.type).toBe("file")
    expect(String((content[1]?.image_url as Record<string, unknown>).url)).toContain("data:image/png;base64,")
    expect(String((content[2]?.image_url as Record<string, unknown>).url)).toContain("data:image/jpeg;base64,")
    expect(String((content[3]?.file as Record<string, unknown>).file_data)).toContain("data:application/pdf")
  })

  it("rejects oversized attachments", async () => {
    const hugeFile = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "huge.bin", {
      type: "application/octet-stream",
    })

    await expect(
      buildGatewayTurnRequestPayload({
        model: "grok-4.1-fast",
        sessionId: "sess_1",
        clientTurnId: "turn_1",
        text: "",
        attachments: [hugeFile],
      })
    ).rejects.toThrow("附件过大：huge.bin")
  })
})
