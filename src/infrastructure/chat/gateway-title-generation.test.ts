import { describe, expect, it, mock } from "bun:test"
import {
  fallbackConversationTitleFromUserPrompt,
  normalizeGeneratedConversationTitle,
  resolvePostCompletionConversationTitle,
  shouldGeneratePostCompletionTitleForModel,
} from "./gateway-title-generation"

describe("gateway title generation", () => {
  it("only targets Expert and Max style NBSearch models", () => {
    expect(shouldGeneratePostCompletionTitleForModel("grok-4.1-fast")).toBe(false)
    expect(shouldGeneratePostCompletionTitleForModel("grok-4.20-0309-reasoning")).toBe(true)
    expect(shouldGeneratePostCompletionTitleForModel("grok-4.20-expert")).toBe(true)
    expect(shouldGeneratePostCompletionTitleForModel("custom-gpt-model")).toBe(false)
  })

  it("falls back to the first ten characters from the first user sentence", () => {
    expect(fallbackConversationTitleFromUserPrompt("请总结苹果公司的财报表现。第二句话不应进入标题")).toBe(
      "请总结苹果公司的财报"
    )
    expect(fallbackConversationTitleFromUserPrompt("\n\n  多行第一句用于测试！第二句")).toBe("多行第一句用于测试")
  })

  it("normalizes generated title text", () => {
    expect(normalizeGeneratedConversationTitle("标题：宏观政策影响。")).toBe("宏观政策影响")
    expect(normalizeGeneratedConversationTitle("```text\n“苹果财报分析”\n```")).toBe("苹果财报分析")
  })

  it("uses OpenAI-compatible gateway when configured", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
      expect(body.model).toBe("gpt-5.4-mini")
      expect(JSON.stringify(body)).toContain("请分析特斯拉未来增长")
      return new Response(
        JSON.stringify({
          id: "chatcmpl_title_1",
          object: "chat.completion",
          created: 1779000000,
          model: "gpt-5.4-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "标题：特斯拉增长展望。",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    })

    const title = await resolvePostCompletionConversationTitle({
      model: "grok-4.20-expert",
      prompt: "请分析特斯拉未来增长。需要包含风险。",
      config: {
        openaiApiBaseUrl: "https://openai.test/v1",
        openaiApiKey: "test-key",
        openaiTranslationModel: "gpt-5.4-mini",
      },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(title).toBe("特斯拉增长展望")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("uses user prompt fallback when OpenAI-compatible gateway is not configured", async () => {
    const fetchMock = mock(async () => {
      throw new Error("should_not_call_openai")
    })

    const title = await resolvePostCompletionConversationTitle({
      model: "grok-4.20-0309-reasoning",
      prompt: "请比较苹果和微软的估值差异。第二句",
      config: {
        openaiApiBaseUrl: "",
        openaiApiKey: "",
        openaiTranslationModel: "gpt-5.4-mini",
      },
      fetchFn: fetchMock as unknown as typeof fetch,
    })

    expect(title).toBe("请比较苹果和微软的估")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
