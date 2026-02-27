import { openAIProvider } from "./openai"
import type { ProviderAdapter } from "./types"

export const providers: ProviderAdapter[] = [openAIProvider]
