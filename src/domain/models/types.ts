export type ModelVisualKind = "speed" | "reasoning" | "spark" | "compute" | "default"

export interface ModelOption {
  id: string
  name: string
  shortName: string
  provider: string
  description: string
  visualKind: ModelVisualKind
}
