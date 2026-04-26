import { describe, expect, it, mock } from "bun:test"
import type { AppConfig } from "@/app/contracts"
import { createStreamingResponse } from "./grok-chat-service-test-helpers"
import { MemoryAppRepository } from "../storage/memory/repository"
import { GrokChatService } from "./grok-chat-service"

const BASE_CONFIG: AppConfig = {
  apiBaseUrl: "http://127.0.0.1:8787",
  apiKey: "test-key",
  defaultModel: "grok-4.1-fast",
  openaiApiBaseUrl: "https://openai.test/v1",
  openaiApiKey: "openai-key",
  openaiTranslationModel: "gpt-5.4-mini",
  voiceEnabled: false,
  themeMode: "light",
  fontSizeMode: "default",
}

function buildCompletedStreamChunk(input: {
  responseId: string
  text: string
  title?: string
}): string {
  return [
    JSON.stringify({
      type: "response.created",
      response: {
        id: input.responseId,
      },
    }),
    JSON.stringify({
      type: "response.output_text.delta",
      delta: input.text,
    }),
    JSON.stringify({
      type: "response.completed",
      response: {
        id: input.responseId,
        ...(input.title ? { title: { newTitle: input.title } } : {}),
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: input.text,
              },
            ],
          },
        ],
      },
    }),
  ].join("")
}

function attachFetch(service: GrokChatService, mockedFetch: typeof fetch): void {
  ;(mockedFetch as unknown as { preconnect: (url: string) => void }).preconnect = () => {}
  ;(service as unknown as { runtimeFetch: typeof fetch }).runtimeFetch = mockedFetch
}

describe("GrokChatService title generation", () => {
  it("uses OpenAI-compatible gateway title for Expert when upstream title is missing", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, BASE_CONFIG)
    const streamChunk = buildCompletedStreamChunk({
      responseId: "resp_expert_title_1",
      text: "专家模式回答正文",
    })
    const openAIRequests: string[] = []
    const mockedFetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        return createStreamingResponse([streamChunk])
      }
      openAIRequests.push(url)
      return new Response(
        JSON.stringify({
          id: "chatcmpl_title_expert_1",
          object: "chat.completion",
          created: 1779000000,
          model: "gpt-5.4-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "专家标题",
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
    }) as unknown as typeof fetch
    attachFetch(service, mockedFetch)

    await service.streamTurn(
      {
        model: "grok-4.20-0309-reasoning",
        text: "请分析美国降息对科技股的影响。需要包含风险。",
        anchors: {
          conversationId: "conv_expert_title_1",
          sessionId: "sess_expert_title_1",
          lastResponseId: "",
        },
      },
      () => {}
    )

    const conversations = await repository.listConversations()
    expect(conversations.find((item) => item.id === "conv_expert_title_1")?.title).toBe("专家标题")
    expect(openAIRequests).toHaveLength(1)
  })

  it("keeps upstream title and skips OpenAI title generation", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, BASE_CONFIG)
    const streamChunk = buildCompletedStreamChunk({
      responseId: "resp_upstream_title_1",
      text: "回答正文",
      title: "上游标题",
    })
    const openAIRequests: string[] = []
    const mockedFetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/v1/responses")) {
        return createStreamingResponse([streamChunk])
      }
      openAIRequests.push(url)
      throw new Error("should_not_call_openai")
    }) as unknown as typeof fetch
    attachFetch(service, mockedFetch)

    await service.streamTurn(
      {
        model: "grok-4.20-expert",
        text: "请总结这轮问题。",
        anchors: {
          conversationId: "conv_upstream_title_1",
          sessionId: "sess_upstream_title_1",
          lastResponseId: "",
        },
      },
      () => {}
    )

    const conversations = await repository.listConversations()
    expect(conversations.find((item) => item.id === "conv_upstream_title_1")?.title).toBe("上游标题")
    expect(openAIRequests).toHaveLength(0)
  })

  it("falls back to the user prompt first sentence when OpenAI gateway is not configured", async () => {
    const repository = new MemoryAppRepository()
    const service = new GrokChatService(repository, {
      ...BASE_CONFIG,
      openaiApiBaseUrl: "",
      openaiApiKey: "",
    })
    const streamChunk = buildCompletedStreamChunk({
      responseId: "resp_max_title_1",
      text: "Max 模式回答正文",
    })
    const mockedFetch = mock(async () => createStreamingResponse([streamChunk])) as unknown as typeof fetch
    attachFetch(service, mockedFetch)

    await service.streamTurn(
      {
        model: "grok-4.20-expert",
        text: "请总结苹果公司的财报表现。第二句话不应进入标题",
        anchors: {
          conversationId: "conv_max_title_1",
          sessionId: "sess_max_title_1",
          lastResponseId: "",
        },
      },
      () => {}
    )

    const conversations = await repository.listConversations()
    expect(conversations.find((item) => item.id === "conv_max_title_1")?.title).toBe("请总结苹果公司的财报")
  })
})
