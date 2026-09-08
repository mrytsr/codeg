import { beforeEach, describe, expect, it } from "vitest"

import {
  clearModelProviderDraftSelection,
  getModelProviderDraftSelection,
  consumeModelProviderDraftSelection,
  resetModelProviderSelectionStore,
  setModelProviderDraftSelection,
} from "./model-provider-selection-store"

describe("model provider draft selection store", () => {
  beforeEach(() => {
    resetModelProviderSelectionStore()
  })

  it("keeps one draft selection per tab", () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "provider-a",
      modelId: "model-a",
    })
    setModelProviderDraftSelection("tab-2", {
      providerId: "provider-b",
      modelId: "model-b",
    })

    expect(getModelProviderDraftSelection("tab-1")).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    })
    expect(getModelProviderDraftSelection("tab-2")).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
    })
  })

  it("clears a tab without affecting other drafts", () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "provider-a",
      modelId: "model-a",
    })
    setModelProviderDraftSelection("tab-2", {
      providerId: "provider-b",
      modelId: "model-b",
    })

    clearModelProviderDraftSelection("tab-1")

    expect(getModelProviderDraftSelection("tab-1")).toBeNull()
    expect(getModelProviderDraftSelection("tab-2")).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
    })
  })

  it("consumes a draft exactly once", () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "provider-a",
      modelId: "model-a",
    })

    expect(consumeModelProviderDraftSelection("tab-1")).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    })
    expect(consumeModelProviderDraftSelection("tab-1")).toBeNull()
    expect(getModelProviderDraftSelection("tab-1")).toBeNull()
  })
})
