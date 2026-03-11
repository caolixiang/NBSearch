import { hasTauriRuntime } from "./runtime-info"

export type ClientLogLevel = "info" | "warn" | "error"

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || "",
    }
  }
  return {
    value: typeof error === "string" ? error : JSON.stringify(error),
  }
}

export async function appendClientLog(args: {
  level: ClientLogLevel
  scope: string
  message: string
  context?: Record<string, unknown>
}): Promise<void> {
  const prefix = `[${args.scope}] ${args.message}`
  if (args.level === "error") {
    console.error(prefix, args.context || {})
  } else if (args.level === "warn") {
    console.warn(prefix, args.context || {})
  } else {
    console.info(prefix, args.context || {})
  }

  if (!hasTauriRuntime()) {
    return
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("append_client_log", {
      payload: {
        level: args.level,
        scope: args.scope,
        message: args.message,
        context: args.context || null,
      },
    })
  } catch (error) {
    console.error("[client-log] append failed", serializeError(error))
  }
}

export async function logClientError(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  const serialized = serializeError(error)
  const message =
    typeof serialized.message === "string" && serialized.message.trim().length > 0
      ? serialized.message.trim()
      : "unknown_error"

  await appendClientLog({
    level: "error",
    scope,
    message,
    context: {
      ...(context || {}),
      error: serialized,
    },
  })
}
