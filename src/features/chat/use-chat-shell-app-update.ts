import { useCallback, useEffect, useState } from "react"
import { installPreparedAppUpdate, prepareAppUpdate } from "@/app/updater"

export function useChatShellAppUpdate() {
  const [readyUpdateVersion, setReadyUpdateVersion] = useState("")
  const [isInstallingPreparedUpdate, setIsInstallingPreparedUpdate] = useState(false)

  useEffect(() => {
    let cancelled = false

    const prepareUpdate = async () => {
      const result = await prepareAppUpdate()
      if (cancelled || !result?.enabled || !result.downloaded || !result.version) {
        return
      }
      setReadyUpdateVersion(result.version)
    }

    void prepareUpdate()

    return () => {
      cancelled = true
    }
  }, [])

  const installReadyUpdate = useCallback(async () => {
    if (isInstallingPreparedUpdate) {
      return
    }

    setIsInstallingPreparedUpdate(true)
    const result = await installPreparedAppUpdate()

    if (!result?.installed) {
      if (result?.error === "no_prepared_update" || result?.error === "prepared_update_stale") {
        setReadyUpdateVersion("")
      }
      setIsInstallingPreparedUpdate(false)
      return
    }
  }, [isInstallingPreparedUpdate])

  return {
    readyUpdateVersion,
    isInstallingPreparedUpdate,
    installReadyUpdate,
  }
}
