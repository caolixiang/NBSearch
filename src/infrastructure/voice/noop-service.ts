import type {
  VoiceService,
  VoiceSessionEventInput,
  VoiceTokenRequest,
  VoiceTokenResult,
} from "../../domain/voice/service"

export class NoopVoiceService implements VoiceService {
  async issueToken(_input: VoiceTokenRequest): Promise<VoiceTokenResult> {
    throw new Error("voice service not implemented yet")
  }

  async reportSessionEvent(_input: VoiceSessionEventInput): Promise<void> {
    throw new Error("voice session event reporting not implemented yet")
  }
}
