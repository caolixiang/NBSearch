export type GatewayConfigDraft = {
  baseUrl: string
  apiKey: string
}

export type GatewaySaveButtonState = {
  hasChanges: boolean
  disabled: boolean
  label: string
}

export function getGatewaySaveButtonState(args: {
  current: GatewayConfigDraft
  saved: GatewayConfigDraft
  busy: boolean
}): GatewaySaveButtonState {
  const hasChanges = args.current.baseUrl !== args.saved.baseUrl || args.current.apiKey !== args.saved.apiKey

  if (args.busy) {
    return {
      hasChanges,
      disabled: true,
      label: "保存中...",
    }
  }

  if (!hasChanges) {
    return {
      hasChanges: false,
      disabled: true,
      label: "已保存",
    }
  }

  return {
    hasChanges: true,
    disabled: false,
    label: "保存",
  }
}
