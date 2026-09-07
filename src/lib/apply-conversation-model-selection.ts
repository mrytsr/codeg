import { updateConversationModelSelection } from "@/lib/api"
import {
  consumeModelProviderDraftSelection,
  setModelProviderDraftSelection,
} from "@/stores/model-provider-selection-store"

/** The connection state and restart action needed to apply launch-time config. */
export interface ModelSelectionConnection {
  isViewer: boolean
  status: string | null
  reapplyConfig: (
    conversationIdOverride?: number,
    options?: { freshSession?: boolean }
  ) => Promise<boolean>
}

export interface ApplyDraftModelSelectionParams {
  tabId: string
  conversationId: number
  connection: ModelSelectionConnection
  /** New conversations have no history; start a new session instead of loading
   *  the unused session that was launched before the provider was selected. */
  freshSession?: boolean
}

/**
 * Save a pre-bind Model Provider choice and make its launch-time config live.
 * Returns the applied selection, or `null` when the draft had no choice. On
 * failure the draft is restored so a retry can save/send the same choice.
 */
export async function applyDraftModelSelection({
  tabId,
  conversationId,
  connection,
  freshSession = false,
}: ApplyDraftModelSelectionParams) {
  const selection = consumeModelProviderDraftSelection(tabId)
  if (!selection) return null

  try {
    await updateConversationModelSelection(
      conversationId,
      selection.providerId,
      selection.modelId
    )
  } catch (error) {
    setModelProviderDraftSelection(tabId, selection)
    throw error
  }

  try {
    if (!connection.isViewer && connection.status === "connected") {
      await connection.reapplyConfig(conversationId, { freshSession })
    }
  } catch (error) {
    setModelProviderDraftSelection(tabId, selection)
    throw error
  }

  return selection
}
