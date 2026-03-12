import { describe, expect, it } from "bun:test"
import { hydrateChatMessagesFromSqliteRows, type SqliteMessageRow } from "./repository"

describe("hydrateChatMessagesFromSqliteRows", () => {
  it("returns voiceEventKey from persisted message content", () => {
    const rows: SqliteMessageRow[] = [
      {
        id: "voice_usr_1",
        role: "user",
        content_json: JSON.stringify({
          text: "给我几张霍尔木兹海峡的照片。",
          voiceEventKey: "user:item:rtc_turn_1",
        }),
        response_id: "",
        previous_response_id: "",
        status: "completed",
        created_at: 100,
      },
    ]

    const messages = hydrateChatMessagesFromSqliteRows(rows)

    expect(messages).toHaveLength(1)
    expect(messages[0]?.voiceEventKey).toBe("user:item:rtc_turn_1")
    expect(messages[0]?.content).toBe("给我几张霍尔木兹海峡的照片。")
  })

  it("collapses repeated voice user finals with the same voiceEventKey", () => {
    const rows: SqliteMessageRow[] = [
      {
        id: "voice_usr_older",
        role: "user",
        content_json: JSON.stringify({
          text: "给我几张霍尔木兹海峡的照片。",
          voiceEventKey: "user:item:rtc_turn_2",
        }),
        response_id: "",
        previous_response_id: "",
        status: "completed",
        created_at: 100,
      },
      {
        id: "voice_usr_newer",
        role: "user",
        content_json: JSON.stringify({
          text: "给我几张霍尔木兹海峡的照片，直接给我照片。",
          voiceEventKey: "user:item:rtc_turn_2",
        }),
        response_id: "",
        previous_response_id: "",
        status: "completed",
        created_at: 110,
      },
      {
        id: "voice_asst_1",
        role: "assistant",
        content_json: JSON.stringify({
          text: "好，来，直接上图。",
        }),
        response_id: "resp_voice_2",
        previous_response_id: "",
        status: "completed",
        created_at: 120,
      },
    ]

    const messages = hydrateChatMessagesFromSqliteRows(rows)

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      id: "voice_usr_newer",
      role: "user",
      content: "给我几张霍尔木兹海峡的照片，直接给我照片。",
      voiceEventKey: "user:item:rtc_turn_2",
    })
    expect(messages[1]).toMatchObject({
      id: "voice_asst_1",
      role: "assistant",
      content: "好，来，直接上图。",
      responseId: "resp_voice_2",
    })
  })
})
