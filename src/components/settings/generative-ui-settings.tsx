"use client"

/**
 * The "UI" tab of Skill Packs: one switch for generative UI (json-render).
 *
 * On, it does two things — assistant replies render ```spec fences as cards,
 * and every agent Codeg starts gets the `json-render` skill that teaches the
 * format — which is why it lives with the skill packs. The switch applies the
 * moment it moves; there is no Save.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Info, LayoutDashboard, Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import {
  SettingCard,
  SettingNote,
  SettingRow,
} from "@/components/shared/setting-card"
import { Switch } from "@/components/ui/switch"
import { invalidateAgentSkillsCache } from "@/hooks/use-agent-skills"
import { primeGenerativeUiEnabled } from "@/hooks/use-generative-ui-enabled"
import {
  getGenerativeUiSettings,
  setGenerativeUiSettings,
  type GenerativeUiSettings,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { GENERATIVE_UI_SETTINGS_CHANGED_EVENT } from "@/lib/types"

const SWITCH_ID = "generative-ui-enabled"

export function GenerativeUiBody({
  onRegisterRefresh,
}: {
  onRegisterRefresh?: (refresh: () => void) => void
}) {
  const t = useTranslations("GenerativeUiSettings")
  const [settings, setSettings] = useState<GenerativeUiSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Bumped by every save and broadcast: a load that started before one of
  // them read an older value and must not overwrite it.
  const generation = useRef(0)
  // Loads numbered as they start: once one has answered, an earlier one
  // that answers later is older news.
  const loadsStarted = useRef(0)
  const newestLoadAnswered = useRef(0)

  /** Read the stored value — the one answer that cannot be out of order —
   *  and hand it to this window's chat as well. A failed read leaves the
   *  switch locked: what it shows can no longer be vouched for. */
  const load = useCallback(() => {
    const started = generation.current
    const read = ++loadsStarted.current
    const stale = () =>
      generation.current !== started || read < newestLoadAnswered.current
    getGenerativeUiSettings()
      .then((loaded) => {
        if (stale()) return
        newestLoadAnswered.current = read
        setSettings(loaded)
        setLoadError(null)
        primeGenerativeUiEnabled(loaded.enabled)
      })
      .catch((err: unknown) => {
        if (stale()) return
        newestLoadAnswered.current = read
        setLoadError(toErrorMessage(err))
      })
  }, [])

  useEffect(() => {
    load()
    onRegisterRefresh?.(load)
  }, [load, onRegisterRefresh])

  // A save from another window or web client. Broadcasts arrive in the order
  // the backend applied the saves, so each one is the newest word; one
  // missed while the connection was down is made up by reading again.
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe<GenerativeUiSettings>(
      GENERATIVE_UI_SETTINGS_CHANGED_EVENT,
      (remote) => {
        generation.current += 1
        setSettings(remote)
        // A broadcast is the stored value as of that save: certain again.
        setLoadError(null)
      }
    )
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    const stopReconnect = onTransportReconnect(load)
    return () => {
      disposed = true
      unsubscribe?.()
      stopReconnect?.()
    }
  }, [load])

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setSaving(true)
      try {
        const saved = await setGenerativeUiSettings({ enabled })
        // Shown at once, then read back: a response can arrive after the
        // broadcast of a later save made elsewhere, and only the stored value
        // settles which of the two is current.
        generation.current += 1
        setSettings(saved)
        load()
        invalidateAgentSkillsCache()
        if (saved.unlink_failures.length > 0) {
          // Off, but some agent still has the skill; its next launch retries.
          toast.warning(t("toasts.unlinkFailed"), {
            description: saved.unlink_failures.join("\n"),
          })
        }
      } catch (err) {
        toast.error(t("toasts.saveFailed"), {
          description: toErrorMessage(err),
        })
      } finally {
        setSaving(false)
      }
    },
    [load, t]
  )

  if (!settings && !loadError) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="flex max-w-2xl flex-col gap-3 pb-4">
        {loadError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
            {loadError}
          </div>
        ) : null}

        <SettingCard>
          <SettingRow
            icon={LayoutDashboard}
            title={t("switchLabel")}
            description={t("switchDescription")}
            htmlFor={SWITCH_ID}
            control={
              <Switch
                id={SWITCH_ID}
                checked={settings?.enabled ?? false}
                disabled={!settings || saving || loadError !== null}
                onCheckedChange={(checked) => void handleToggle(checked)}
              />
            }
          />
        </SettingCard>

        {settings?.skill_conflict ? (
          <SettingNote
            icon={TriangleAlert}
            className="border-amber-500/40 bg-amber-500/5"
          >
            {t("conflict")}
          </SettingNote>
        ) : null}

        <SettingNote icon={Info}>{t("usage")}</SettingNote>
        <SettingNote icon={Info}>{t("effect")}</SettingNote>
      </div>
    </div>
  )
}
