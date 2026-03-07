export type { RenewedAssetUrlPayload } from "./gateway-media-renewal"

export {
  readCardAssetMeta,
  withCardAssetMeta,
  cloneCardAttachmentPayload,
  coerceToolMetaCard,
  isLocalRenewableImageAssetId,
} from "./gateway-media-asset-meta"

export {
  resolveGatewayMediaUrl,
  normalizeCardAttachmentUrls,
} from "./gateway-media-url"

export {
  parseRenewedAssetUrlResponse,
  shouldRenewCardAssetUrl,
  withCardAssetMetadata,
} from "./gateway-media-renewal"

export {
  collectCardUrlReplacements,
  applyUrlReplacementsOutsideToolMeta,
} from "./gateway-media-card-updates"

export {
  appendMissingCardsFromReasoningEvents,
  appendMissingGeneratedImageMarkdownOutsideToolMeta,
  pruneGeneratedImageMarkdownOutsideToolMeta,
  collectGeneratedImageUrls,
  mergeRenewedCardsIntoReasoningEvents,
  isGeneratedImageNarration,
  canonicalizeGeneratedImagePath,
  preferGeneratedCardByUrlQuality,
  dedupeGeneratedImageCards,
  inferGeneratedImageAssetId,
  resolveRenewAssetIdForCard,
  normalizeGeneratedImageCardsInReasoningEvents,
  extractGeneratedImageMarkdown,
} from "./gateway-generated-image-assets"
