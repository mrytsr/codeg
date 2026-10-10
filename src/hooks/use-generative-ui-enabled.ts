"use client"

/**
 * Read the global "generative UI enabled" flag (the `generative_ui.enabled`
 * setting): whether a ```spec fence in an assistant reply renders as a
 * json-render card. Cached at module scope, so the many fences of a long
 * conversation share one fetch.
 *
 * Cross-window reactive exactly like `useFeedbackEnabled`: the settings UI
 * runs in a SEPARATE window, the backend broadcasts
 * `generative-ui-settings://changed` on every save, and this hook subscribes
 * to it once per window. `primeGenerativeUiEnabled` gives the saving window an
 * instant update before the broadcast round-trips, and a `saveGeneration`
 * guard keeps a slow initial load from overwriting a newer value.
 *
 * A switch move also changes which skills agents have on disk (the
 * `json-render` skill comes and goes with it), so the broadcast drops this
 * window's cached skill lists too.
 */

import { useEffect, useState } from "react"

import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { getGenerativeUiSettings } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { GENERATIVE_UI_SETTINGS_CHANGED_EVENT } from "@/lib/types"
import type { GenerativeUiSettings } from "@/lib/api"

let cached: boolean | null = null
let inflight: Promise<boolean> | null = null
/** Bumped by every save and broadcast: a read that started before one of
 *  them is older than the value it would overwrite. */
let saveGeneration = 0
/** Reads of the stored value — the initial load, reconnect re-fetches —
 *  numbered as they start, so a read that lands after a later one has
 *  committed is dropped too. */
let readsStarted = 0
let newestReadCommitted = 0
let crossWindowWired = false
const listeners = new Set<(enabled: boolean) => void>()

function notify(enabled: boolean): void {
  for (const listener of listeners) listener(enabled)
}

/** Authoritative update: bump the generation so a slower in-flight initial
 *  load can't overwrite it, set the cache, and notify all mounted hooks. */
function applyEnabled(enabled: boolean): void {
  saveGeneration += 1
  cached = enabled
  notify(enabled)
}

/** Seed/overwrite the cache and notify all mounted hooks (called by the
 *  settings page after a successful save). Other windows converge via the
 *  backend broadcast. */
export function primeGenerativeUiEnabled(enabled: boolean): void {
  // A primed cache is never loaded again, so it must follow broadcasts from
  // here on even if no hook in this window has mounted yet.
  ensureCrossWindowSync()
  applyEnabled(enabled)
}

/** Start a read of the stored value. The returned commit applies what it
 *  read only if no save or broadcast happened since, and no read that
 *  started later has committed already. Reads never bump `saveGeneration`:
 *  one read must not void another that is newer than it. */
function beginRead(): (value: boolean) => void {
  const read = ++readsStarted
  const startGeneration = saveGeneration
  return (value) => {
    if (saveGeneration !== startGeneration || read < newestReadCommitted) {
      return
    }
    newestReadCommitted = read
    cached = value
    notify(value)
  }
}

/** Kick off (or reuse) the one-shot initial load. */
function ensureLoaded(): Promise<boolean> {
  if (inflight) return inflight
  const commit = beginRead()
  inflight = getGenerativeUiSettings()
    .then((s) => s.enabled)
    .catch(() => false)
    .then((value) => {
      commit(value)
      return cached ?? value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Wire the cross-window convergence once per window, and re-fetch on WS
 *  reconnect since the broadcaster drops events fired while no client is
 *  listening. */
function ensureCrossWindowSync(): void {
  if (crossWindowWired) return
  crossWindowWired = true
  void subscribe<GenerativeUiSettings>(
    GENERATIVE_UI_SETTINGS_CHANGED_EVENT,
    (s) => {
      applyEnabled(s.enabled)
      invalidateAgentSkillsCache()
    }
  ).catch(() => {
    // Wiring failed (e.g. transport not ready yet) — clear the guard so a
    // later mount retries instead of silently never subscribing.
    crossWindowWired = false
  })
  onTransportReconnect(() => {
    const commit = beginRead()
    void getGenerativeUiSettings()
      .then((s) => commit(s.enabled))
      .catch(() => {})
  })
}

export function useGenerativeUiEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => cached ?? false)

  useEffect(() => {
    ensureCrossWindowSync()
    listeners.add(setEnabled)
    if (cached === null) void ensureLoaded()
    return () => {
      listeners.delete(setEnabled)
    }
  }, [])

  return enabled
}
