import { useCallback, useEffect, useRef, useState } from "react"
import type { AppRuntime } from "@/app/contracts"
import type { ModelOption } from "@/domain/models/types"
import {
  DEFAULT_MODEL_OPTIONS,
  fetchRemoteModelOptions,
  persistModelOptions,
  persistSelectedModel,
  readStoredModelOptions,
  readStoredSelectedModel,
  resolveSelectedModel,
} from "@/infrastructure/models/catalog"

const MODEL_SYNC_NOTICE_DURATION_MS = 2200

export type ModelSyncNotice = {
  message: string
  tone: "success" | "error"
}

function getInitialModelOptions(): ModelOption[] {
  const stored = readStoredModelOptions()
  if (stored.length > 0) {
    return stored
  }
  return DEFAULT_MODEL_OPTIONS
}

export function useChatShellModels(runtime: AppRuntime) {
  const [modelSyncNotice, setModelSyncNotice] = useState<ModelSyncNotice | null>(null)
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(() => getInitialModelOptions())
  const [selectedModel, setSelectedModel] = useState(() => {
    const models = getInitialModelOptions()
    return resolveSelectedModel(models, [readStoredSelectedModel(), runtime.config.defaultModel])
  })
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const modelSyncNoticeTimerRef = useRef<number | null>(null)

  const clearModelSyncNoticeTimer = useCallback(() => {
    if (modelSyncNoticeTimerRef.current !== null) {
      window.clearTimeout(modelSyncNoticeTimerRef.current)
      modelSyncNoticeTimerRef.current = null
    }
  }, [])

  const showModelSyncNotice = useCallback(
    (message: string, tone: "success" | "error") => {
      clearModelSyncNoticeTimer()
      setModelSyncNotice({ message, tone })
      modelSyncNoticeTimerRef.current = window.setTimeout(() => {
        setModelSyncNotice(null)
        modelSyncNoticeTimerRef.current = null
      }, MODEL_SYNC_NOTICE_DURATION_MS)
    },
    [clearModelSyncNoticeTimer]
  )

  const refreshModelOptions = useCallback(
    async (silent = false): Promise<void> => {
      setIsRefreshingModels(true)
      try {
        const remoteModels = await fetchRemoteModelOptions(runtime.config)
        setModelOptions(remoteModels)
        persistModelOptions(remoteModels)
        setSelectedModel((current) =>
          resolveSelectedModel(remoteModels, [current, readStoredSelectedModel(), runtime.config.defaultModel])
        )
        if (!silent) {
          showModelSyncNotice("已同步", "success")
        }
      } catch {
        if (!silent) {
          showModelSyncNotice("同步失败，请重试", "error")
        }
      } finally {
        setIsRefreshingModels(false)
      }
    },
    [runtime.config, showModelSyncNotice]
  )

  useEffect(() => {
    return () => {
      clearModelSyncNoticeTimer()
    }
  }, [clearModelSyncNoticeTimer])

  useEffect(() => {
    void refreshModelOptions(true)
  }, [refreshModelOptions])

  useEffect(() => {
    if (!selectedModel.trim()) {
      return
    }
    persistSelectedModel(selectedModel)
  }, [selectedModel])

  return {
    modelSyncNotice,
    modelOptions,
    selectedModel,
    setSelectedModel,
    isRefreshingModels,
    refreshModelOptions,
  }
}
