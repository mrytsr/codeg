import { render } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspaceWindowHistoryProvider } from "./workspace-window-history"

function mount() {
  return render(
    <StrictMode>
      <WorkspaceWindowHistoryProvider>
        <div />
      </WorkspaceWindowHistoryProvider>
    </StrictMode>
  )
}

describe("WorkspaceWindowHistoryProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, "")
  })

  it("steps back once when a reload left the pointer on a pushed entry", () => {
    window.history.replaceState({ codegWorkspaceWindow: "workbench-route" }, "")
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    mount()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it("never steps back twice, even when StrictMode re-runs the mount effect", () => {
    window.history.replaceState({ codegWorkspaceWindow: "file-workspace" }, "")
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    mount()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it("leaves history alone when the pointer is on a keyless entry", () => {
    window.history.replaceState({}, "")
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    mount()
    expect(back).not.toHaveBeenCalled()
  })
})
