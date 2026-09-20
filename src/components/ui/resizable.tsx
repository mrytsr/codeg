"use client"

import * as React from "react"
import * as ResizablePrimitive from "react-resizable-panels"
import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  style,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className
      )}
      style={{ ...style, overflow: "clip" }}
      {...props}
    />
  )
}

function ResizablePanel({
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return <ResizablePrimitive.Panel {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean
}) {
  void withHandle
  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        // The thickened hover/drag line is OPAQUE (--resize-handle-hover /
        // -drag in globals.css), not `bg-foreground/xx`: the handle box is 1px
        // wide, so a 5px line centred on it leaves a 1px core that neither
        // panel backs, and a translucent line lights up over that core wherever
        // the panels' own background differs from the page's — reading as two
        // lines with a seam between them.
        //
        // That same centring paints (5-1)/2 = 2px into each neighbouring
        // panel, which a native webview would paint back over — hence the
        // matching 2px inset in `browser-surface-host.tsx`. Changing the
        // thickness here means changing that inset too.
        "relative z-20 flex w-px items-center justify-center overflow-visible [--resize-handle-thickness:1px] data-[resize-handle-state=hover]:[--resize-handle-thickness:5px] data-[resize-handle-state=drag]:[--resize-handle-thickness:5px] after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:h-full before:w-[var(--resize-handle-thickness)] before:-translate-x-1/2 before:bg-border before:transition-[width,height,background-color] before:duration-150 before:ease-out data-[resize-handle-state=hover]:before:bg-[var(--resize-handle-hover)] data-[resize-handle-state=drag]:before:bg-[var(--resize-handle-drag)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:inset-x-0 data-[panel-group-direction=vertical]:after:top-1/2 data-[panel-group-direction=vertical]:after:h-3 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:before:inset-x-0 data-[panel-group-direction=vertical]:before:inset-y-auto data-[panel-group-direction=vertical]:before:top-1/2 data-[panel-group-direction=vertical]:before:h-[var(--resize-handle-thickness)] data-[panel-group-direction=vertical]:before:w-full data-[panel-group-direction=vertical]:before:-translate-y-1/2 data-[panel-group-direction=vertical]:before:translate-x-0",
        className
      )}
      {...props}
    />
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
