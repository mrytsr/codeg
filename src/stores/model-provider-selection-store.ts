"use client"

import { create } from "zustand"

/** A pre-bind Model Provider choice made in a draft composer. */
export interface ModelProviderDraftSelection {
  providerId: string
  modelId: string
}

interface ModelProviderSelectionStore {
  drafts: Record<string, ModelProviderDraftSelection>
  setDraft: (tabId: string, selection: ModelProviderDraftSelection) => void
  clearDraft: (tabId: string) => void
  consumeDraft: (tabId: string) => ModelProviderDraftSelection | null
}

/**
 * Draft Model Provider choices only live until a draft conversation is bound.
 * They are keyed by tab (not component instance) because the composer can mount
 * two picker instances (inline + collapsed) and can remount either one as
 * selectors/connection state changes.
 */
const useModelProviderSelectionStore = create<ModelProviderSelectionStore>(
  (set, get) => ({
    drafts: {},
    setDraft: (tabId, selection) =>
      set((state) => ({ drafts: { ...state.drafts, [tabId]: selection } })),
    clearDraft: (tabId) =>
      set((state) => {
        if (!(tabId in state.drafts)) return state
        const drafts = { ...state.drafts }
        delete drafts[tabId]
        return { drafts }
      }),
    consumeDraft: (tabId) => {
      const selection = get().drafts[tabId] ?? null
      if (selection) get().clearDraft(tabId)
      return selection
    },
  })
)

/** Read the draft choice outside React (tests and non-hook send paths). */
export function getModelProviderDraftSelection(
  tabId?: string | null
): ModelProviderDraftSelection | null {
  return tabId == null
    ? null
    : (useModelProviderSelectionStore.getState().drafts[tabId] ?? null)
}

/** Subscribe to the draft choice for one composer tab. */
export function useModelProviderDraftSelection(
  tabId?: string | null
): ModelProviderDraftSelection | null {
  return useModelProviderSelectionStore((s) =>
    tabId == null ? null : (s.drafts[tabId] ?? null)
  )
}

/** Store a selection made before the conversation row exists. */
export function setModelProviderDraftSelection(
  tabId: string,
  selection: ModelProviderDraftSelection
): void {
  useModelProviderSelectionStore.getState().setDraft(tabId, selection)
}

/** Remove one tab's draft choice without affecting other tabs. */
export function clearModelProviderDraftSelection(tabId: string): void {
  useModelProviderSelectionStore.getState().clearDraft(tabId)
}

/** Atomically take the draft for the send path, preventing duplicate saves. */
export function consumeModelProviderDraftSelection(
  tabId: string
): ModelProviderDraftSelection | null {
  return useModelProviderSelectionStore.getState().consumeDraft(tabId)
}

/** Test-only: clear all tab-keyed draft selections. */
export function resetModelProviderSelectionStore(): void {
  useModelProviderSelectionStore.setState({ drafts: {} })
}
