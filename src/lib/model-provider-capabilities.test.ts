import { describe, expect, it } from "vitest"

import {
  countCompatibleModelProviders,
  getModelProviderApiTypes,
} from "./model-provider-capabilities"
import type { ModelProviderRecord } from "./model-provider-types"

function provider(
  overrides: Partial<ModelProviderRecord> = {}
): ModelProviderRecord {
  return {
    providerId: "provider",
    api: "openai-completions",
    baseUrl: "https://example.test",
    enabled: true,
    models: [{ id: "model", reasoning: false, input: "text" }],
    apiKeyMasked: "",
    hasApiKey: true,
    ...overrides,
  }
}

describe("model provider capabilities", () => {
  it("declares supported API families per agent", () => {
    expect(getModelProviderApiTypes("claude_code")).toEqual([
      "anthropic-messages",
    ])
    expect(getModelProviderApiTypes("codex")).toEqual([
      "openai-completions",
      "openai-responses",
    ])
    expect(getModelProviderApiTypes("custom:agent")).toEqual([])
  })

  it("counts enabled providers with a matching API and at least one model", () => {
    const providers = [
      provider({ providerId: "match" }),
      provider({ providerId: "wrong-api", api: "anthropic-messages" }),
      provider({ providerId: "disabled", enabled: false }),
      provider({ providerId: "empty", models: [] }),
    ]
    expect(countCompatibleModelProviders(providers, "codex")).toBe(1)
  })
})
