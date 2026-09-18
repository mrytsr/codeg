import type { DbConversationSummary } from "@/lib/types"

export const ATTACH_FILE_TO_SESSION_EVENT = "codeg:attach-file-to-session"

export interface AttachFileToSessionDetail {
  tabId: string
  path: string
  /**
   * Optional 1-based, inclusive line span to attach as a ranged file badge
   * (`foo.ts:10-25`). Omitted by whole-file callers (file tree, git changes);
   * supplied by the editor's "add selection to chat". When present the consumer
   * encodes it into the badge uri (`file://…#L10-25`) and label.
   */
  range?: { start: number; end: number }
}

export function emitAttachFileToSession(
  detail: AttachFileToSessionDetail
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AttachFileToSessionDetail>(ATTACH_FILE_TO_SESSION_EVENT, {
      detail,
    })
  )
}

export const ATTACH_SESSION_TO_SESSION_EVENT = "codeg:attach-session-to-session"

export interface AttachSessionToSessionDetail {
  /** The conversation tab whose composer receives the mention badge. */
  tabId: string
  /**
   * The conversation being mentioned. Carried whole (rather than by id) so the
   * consumer builds the badge through the same `sessionToSuggestion` adapter the
   * `@` panel uses — one source of truth for the label / `codeg://session/<id>`
   * uri / agent + status + branch meta.
   */
  conversation: DbConversationSummary
}

export function emitAttachSessionToSession(
  detail: AttachSessionToSessionDetail
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AttachSessionToSessionDetail>(
      ATTACH_SESSION_TO_SESSION_EVENT,
      { detail }
    )
  )
}

/**
 * In-memory handoff for mentions aimed at a composer that does not exist yet:
 * "At in new conversation" opens a tab and immediately emits, but
 * `dispatchEvent` is synchronous — the new tab's composer has not mounted, so
 * the live event would be lost. Callers queue here FIRST, then emit; the
 * target composer drains the queue once it is ready, and the live-event
 * handler drains it too so a composer that WAS mounted never applies the
 * queued copy on top of the live one. Keyed by tab id, capped FIFO — a tab
 * that closes before mounting just drops its entry.
 */
const PENDING_SESSION_ATTACHMENTS_LIMIT = 8
const pendingSessionAttachments = new Map<string, DbConversationSummary>()

export function queuePendingSessionAttachment(
  tabId: string,
  conversation: DbConversationSummary
): void {
  if (pendingSessionAttachments.size >= PENDING_SESSION_ATTACHMENTS_LIMIT) {
    const oldest = pendingSessionAttachments.keys().next().value
    if (oldest !== undefined) pendingSessionAttachments.delete(oldest)
  }
  pendingSessionAttachments.set(tabId, conversation)
}

export function takePendingSessionAttachment(
  tabId: string
): DbConversationSummary | null {
  const conversation = pendingSessionAttachments.get(tabId) ?? null
  if (conversation !== null) pendingSessionAttachments.delete(tabId)
  return conversation
}

export const APPEND_TEXT_TO_SESSION_EVENT = "codeg:append-text-to-session"

export interface AppendTextToSessionDetail {
  tabId: string
  text: string
}

export function emitAppendTextToSession(
  detail: AppendTextToSessionDetail
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AppendTextToSessionDetail>(APPEND_TEXT_TO_SESSION_EVENT, {
      detail,
    })
  )
}
