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
    expect(content[1]?.type).toBe("image_url")
    expect(String((content[1]?.image_url as Record<string, unknown>).url)).toContain("data:image/png;base64,")
    expect(content[2]?.type).toBe("file")
    expect(String((content[2]?.file as Record<string, unknown>).file_data)).toContain(
      "data:text/plain"
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
    })

    expect(payload["input"]).toBeUndefined()
    expect(payload["previous_response_id"]).toBeUndefined()
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
