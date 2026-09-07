import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyDraftModelSelection,
  type ModelSelectionConnection,
} from "./apply-conversation-model-selection"
import {
  getModelProviderDraftSelection,
  resetModelProviderSelectionStore,
  setModelProviderDraftSelection,
} from "@/stores/model-provider-selection-store"

vi.mock("@/lib/api", () => ({
  updateConversationModelSelection: vi.fn(),
}))

const { updateConversationModelSelection } = vi.mocked(
  await import("@/lib/api")
)

const selection = { providerId: "anthropic", modelId: "claude-opus-4-5" }

function connection(
  overrides: Partial<ModelSelectionConnection> = {}
): ModelSelectionConnection {
  return {
    isViewer: false,
    status: "connected",
    reapplyConfig: vi.fn(async () => true),
    ...overrides,
  }
}

describe("applyDraftModelSelection", () => {
  beforeEach(() => {
    resetModelProviderSelectionStore()
    updateConversationModelSelection.mockReset()
  })

  it("saves the draft and applies it to a fresh session", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockResolvedValue(undefined)
    const conn = connection()

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        connection: conn,
        freshSession: true,
      })
    ).resolves.toEqual(selection)

    expect(updateConversationModelSelection).toHaveBeenCalledWith(
      42,
      selection.providerId,
      selection.modelId
    )
    expect(conn.reapplyConfig).toHaveBeenCalledWith(42, { freshSession: true })
    expect(getModelProviderDraftSelection("tab-1")).toBeNull()
  })

  it("keeps resume semantics for an existing conversation", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockResolvedValue(undefined)
    const conn = connection()

    await applyDraftModelSelection({
      tabId: "tab-1",
      conversationId: 42,
      connection: conn,
    })

    expect(conn.reapplyConfig).toHaveBeenCalledWith(42, {
      freshSession: false,
    })
  })

  it("does nothing when the draft has no selection", async () => {
    const conn = connection()

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        connection: conn,
      })
    ).resolves.toBeNull()

    expect(updateConversationModelSelection).not.toHaveBeenCalled()
    expect(conn.reapplyConfig).not.toHaveBeenCalled()
  })

  it("restores the draft and skips reconnect when saving fails", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockRejectedValue(new Error("save failed"))
    const conn = connection()

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        connection: conn,
      })
    ).rejects.toThrow("save failed")

    expect(conn.reapplyConfig).not.toHaveBeenCalled()
    expect(getModelProviderDraftSelection("tab-1")).toEqual(selection)
  })

  it("restores the draft when applying the saved selection fails", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockResolvedValue(undefined)
    const conn = connection({
      reapplyConfig: vi.fn(async () => {
        throw new Error("reconnect failed")
      }),
    })

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        connection: conn,
      })
    ).rejects.toThrow("reconnect failed")

    expect(updateConversationModelSelection).toHaveBeenCalledTimes(1)
    expect(getModelProviderDraftSelection("tab-1")).toEqual(selection)
  })
})
