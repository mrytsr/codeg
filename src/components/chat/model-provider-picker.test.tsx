import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { resetModelProviderSelectionStore } from "@/stores/model-provider-selection-store"

import { ModelProviderPicker } from "./model-provider-picker"
import enMessages from "@/i18n/messages/en.json"
import type { ModelProviderRecord } from "@/lib/model-provider-types"

const reapplyConfig = vi.fn(async () => true)
vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    isViewer: false,
    status: "connected",
    reapplyConfig,
  }),
}))
vi.mock("@/hooks/use-model-providers", () => ({
  useModelProviders: () => ({
    records: recordsFixture(),
    fresh: true,
    refresh: vi.fn(),
  }),
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({
    agents: [{ agent_type: "claude_code", model_source: "provider" }],
    fresh: true,
    refresh: vi.fn(),
  }),
}))
let tabStoreState: {
  tabs: Array<{ id: string; conversationId: number | null }>
} = { tabs: [{ id: "tab-1", conversationId: 42 }] }
vi.mock("@/stores/tab-store", () => ({
  useTabStore: (selector: (s: unknown) => unknown) => selector(tabStoreState),
}))
vi.mock("@/stores/app-workspace-store", async () => {
  const { create } = await import("zustand")
  const store = create<{
    conversations: Array<Record<string, unknown>>
    applyConversationUpsert: (summary: Record<string, unknown>) => void
    refreshConversations: () => Promise<void>
  }>(() => ({
    conversations: [
      {
        id: 42,
        model_source: "provider",
        model_provider_id: "anthropic",
        model_provider_model_id: "claude-sonnet-4-5",
        model: "claude-sonnet-4-5",
      },
    ],
    applyConversationUpsert: (summary) =>
      store.setState((s) => ({
        conversations: s.conversations.map((c) =>
          (c.id as number) === summary.id ? summary : c
        ),
      })),
    refreshConversations: vi.fn(),
  }))
  return { useAppWorkspaceStore: store }
})
const updateSelection = vi.fn()
vi.mock("@/lib/api", () => ({
  updateConversationModelSelection: (...args: unknown[]) =>
    updateSelection(...args),
}))

function recordsFixture(): ModelProviderRecord[] {
  return [
    {
      providerId: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [
        {
          id: "claude-sonnet-4-5",
          reasoning: false,
          input: "text",
          contextWindow: "200000",
        },
        { id: "claude-opus-4-5", reasoning: true, input: "text-image" },
      ],
    },
    // Enabled but incompatible with claude_code (openai family) — must not show.
    {
      providerId: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [{ id: "gpt-5.1", reasoning: false, input: "text" }],
    },
    // Disabled — must not show even though the API family matches.
    {
      providerId: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      enabled: false,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [{ id: "deepseek-chat", reasoning: false, input: "text" }],
    },
  ]
}

function renderPicker() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ModelProviderPicker agentType="claude_code" tabId="tab-1" />
    </NextIntlClientProvider>
  )
}

describe("ModelProviderPicker", () => {
  beforeEach(() => {
    updateSelection.mockReset()
    reapplyConfig.mockClear()
    resetModelProviderSelectionStore()
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: 42 }] }
  })

  it("shows the conversation's current provider · model selection", async () => {
    renderPicker()
    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    expect(
      within(trigger).getByText("anthropic · claude-sonnet-4-5")
    ).toBeInTheDocument()
  })

  it("lists compatible enabled providers fully expanded and saves a new choice", async () => {
    renderPicker()
    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    fireEvent.click(trigger)

    // Anthropic models are visible without expanding; the incompatible OpenAI
    // provider and the disabled DeepSeek provider are absent.
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument()
    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument()
    expect(screen.queryByText("gpt-5.1")).not.toBeInTheDocument()
    expect(screen.queryByText("deepseek-chat")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("claude-opus-4-5"))
    expect(updateSelection).toHaveBeenCalledWith(
      42,
      "anthropic",
      "claude-opus-4-5"
    )
    await vi.waitFor(() => {
      expect(reapplyConfig).toHaveBeenCalledTimes(1)
    })
    expect(reapplyConfig).toHaveBeenCalledWith(42)
  })

  it("keeps a pre-bind selection across remounts without saving it", async () => {
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: null }] }
    const { unmount } = renderPicker()
    fireEvent.click(
      await screen.findByRole("button", { name: "Model provider" })
    )
    fireEvent.click(screen.getByText("claude-opus-4-5"))
    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-opus-4-5"
      )
    ).toBeInTheDocument()
    expect(updateSelection).not.toHaveBeenCalled()

    unmount()
    renderPicker()
    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-opus-4-5"
      )
    ).toBeInTheDocument()
  })

  it("offers a native reset that clears the conversation selection", async () => {
    renderPicker()
    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByText("Back to native config"))
    expect(updateSelection).toHaveBeenCalledWith(42, null, null)
    await vi.waitFor(() => {
      expect(reapplyConfig).toHaveBeenCalledTimes(1)
    })
    expect(reapplyConfig).toHaveBeenCalledWith(42)
  })
})
