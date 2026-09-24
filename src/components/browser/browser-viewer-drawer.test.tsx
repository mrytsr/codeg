import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  openBrowserTab: vi.fn((): string | null => "browser:new"),
  fileTabs: [] as unknown[],
  /** Every tab the drawer showed, first paint included. */
  shown: [] as string[],
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openBrowserTab: mocks.openBrowserTab,
    switchFileTab: vi.fn(),
  }),
  useWorkspaceFileTabs: () => ({ fileTabs: mocks.fileTabs }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => null,
}))
vi.mock("./browser-tab-view", () => ({
  BrowserTabView: ({ tab }: { tab: { id: string } }) => {
    mocks.shown.push(tab.id)
    return null
  },
}))

function browserRecord(id: string, remote: boolean) {
  return {
    id,
    kind: "browser",
    folderId: 1,
    title: "localhost:3000",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: {
      initialUrl: "http://localhost:3000/",
      openerTabId: null,
      profile: "default",
      ...(remote ? { remote: true } : {}),
    },
  }
}

import { BrowserViewerDrawer } from "./browser-viewer-drawer"

function renderDrawer(remote?: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserViewerDrawer
        url="http://localhost:3000/"
        remote={remote}
        open
        onOpenChange={() => {}}
      />
    </NextIntlClientProvider>
  )
}

describe("BrowserViewerDrawer", () => {
  beforeEach(() => {
    mocks.openBrowserTab.mockReset()
    mocks.openBrowserTab.mockImplementation(() => "browser:new")
    mocks.fileTabs = []
    mocks.shown = []
  })

  it("opens the workspace record without activating the file column", () => {
    renderDrawer()
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://localhost:3000/",
      {
        activate: false,
      }
    )
  })

  // Seen from a remote workspace window, the address is that host's: the
  // record it opens must be a remote one, never a page of this computer.
  it("opens an address of the remote host as a remote record", () => {
    renderDrawer(true)
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://localhost:3000/",
      {
        activate: false,
        remote: true,
      }
    )
  })

  // The same page is open locally AND as a remote tab: the drawer must never
  // show the local one for a remote request, not even for the first paint
  // before its own open has resolved.
  it("shows only the remote record for a remote request", () => {
    mocks.fileTabs = [
      browserRecord("browser:local", false),
      browserRecord("browser:remote", true),
    ]
    mocks.openBrowserTab.mockImplementation(() => "browser:remote")
    renderDrawer(true)
    expect(mocks.shown.length).toBeGreaterThan(0)
    expect(new Set(mocks.shown)).toEqual(new Set(["browser:remote"]))
  })

  it("shows only the local record for a local request", () => {
    mocks.fileTabs = [
      browserRecord("browser:remote", true),
      browserRecord("browser:local", false),
    ]
    mocks.openBrowserTab.mockImplementation(() => "browser:local")
    renderDrawer(false)
    expect(new Set(mocks.shown)).toEqual(new Set(["browser:local"]))
  })
})
