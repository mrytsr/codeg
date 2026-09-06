"use client"

import { useEffect, useState } from "react"
import { Check, ChevronDown, Loader2, Server } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useModelProviderService } from "@/stores/model-provider-mock"
import type { ModelProviderRecord } from "@/lib/model-provider-types"
import { cn } from "@/lib/utils"

interface Selection {
  providerId: string
  modelId: string
}

interface ModelProviderPickerDemoProps {
  /** Extra classes for the trigger button (compact on mobile, etc.). */
  className?: string
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
}

/**
 * DEMO — the "new design" two-level model selector (provider → model) as a
 * single fully expanded list: every provider renders as a static group header
 * with all of its models visible beneath it (no expand/collapse). Fed by the
 * mock provider store, so it shares the same data as the Model Providers
 * settings page. Mounted next to the real model selector on wide composers and
 * next to the cog on narrow/mobile ones so the interaction can be reviewed
 * before the backend wiring lands.
 */
export function ModelProviderPickerDemo({
  className,
  side = "bottom",
  align = "start",
}: ModelProviderPickerDemoProps) {
  const t = useTranslations("ModelProviderPickerDemo")
  const service = useModelProviderService()
  const [records, setRecords] = useState<ModelProviderRecord[] | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    service.list().then((rows) => {
      if (!alive) return
      setRecords(rows)
      const first = rows.find((r) => r.enabled && r.models.length > 0)
      if (first) {
        setSelection(
          (prev) =>
            prev ?? {
              providerId: first.providerId,
              modelId: first.models[0].id,
            }
        )
      }
    })
    return () => {
      alive = false
    }
  }, [service])

  const visibleRecords = records?.filter((r) => r.enabled) ?? []
  const label = selection
    ? `${selection.providerId} · ${selection.modelId}`
    : t("placeholder")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={t("openPicker")}
          className={cn(
            "min-w-0 gap-1 px-1.5 text-muted-foreground",
            className
          )}
        >
          <Badge
            variant="outline"
            className="border-dashed px-1 text-2xs font-normal text-amber-500"
          >
            {t("demoTag")}
          </Badge>
          <span className="max-w-[10rem] truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden p-1"
      >
        {!records ? (
          <div className="flex h-28 items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <ScrollArea className="max-h-80">
            <div className="space-y-1.5">
              {visibleRecords.map((r) => (
                <div key={r.providerId}>
                  <div
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2 py-1",
                      !r.enabled && "opacity-50"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold">
                        {r.providerId}
                      </span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {r.models.length} · {r.enabled ? r.api : t("disabled")}
                      </span>
                    </span>
                  </div>
                  <div className="ml-3 space-y-0.5 border-l pl-2">
                    {r.models.map((m) => {
                      const active =
                        selection?.providerId === r.providerId &&
                        selection?.modelId === m.id
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            setSelection({
                              providerId: r.providerId,
                              modelId: m.id,
                            })
                            setOpen(false)
                          }}
                          className={cn(
                            "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-muted/50",
                            active && "text-primary"
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">
                              {m.id}
                            </span>
                            <span className="block truncate text-2xs text-muted-foreground">
                              {[
                                m.input === "text-image" ? t("vision") : null,
                                m.reasoning ? t("reasoning") : null,
                                m.contextWindow ? `${m.contextWindow}` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "\u00a0"}
                            </span>
                          </span>
                          {active && (
                            <Check className="size-3.5 shrink-0 text-primary" />
                          )}
                        </button>
                      )
                    })}
                    {r.models.length === 0 && (
                      <div className="px-2 py-1.5 text-2xs text-muted-foreground">
                        {t("noModels")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {visibleRecords.length === 0 && (
                <div className="flex items-center gap-1.5 px-2 py-3 text-2xs text-muted-foreground">
                  <Server className="size-3" />
                  {t("noProviders")}
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}
