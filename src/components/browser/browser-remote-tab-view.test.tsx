import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  baseUrl: "https://dev.example.com",
  openBrowserTab: vi.fn(() => "browser:new"),
  copy: vi.fn(() => Promise.resolve(true)),
  toast: { success: vi.fn(), error: vi.fn() },
  surfaceHost: vi.fn(() => null),
}))

vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => mocks.baseUrl,
  isDesktop: () => true,
  isRemoteDesktopMode: () => true,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => ({ openBrowserTab: mocks.openBrowserTab }),
}))
vi.mock(import("@/lib/utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  copyTextToClipboard: mocks.copy,
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))
// The native surface: a remote tab must never get one.
vi.mock("./browser-surface-host", () => ({
  BrowserSurfaceHost: mocks.surfaceHost,
}))

import { BrowserRemoteTabView } from "./browser-remote-tab-view"
import { BrowserTabView } from "./browser-tab-view"

function remoteTab(url: string): BrowserWorkspaceTab {
  return {
    id: "browser:r",
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
      initialUrl: url,
      openerTabId: null,
      profile: "default",
      remote: true,
    },
  } as BrowserWorkspaceTab
}

function renderView(url: string, view = BrowserRemoteTabView) {
  const View = view
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <View tab={remoteTab(url)} />
    </NextIntlClientProvider>
  )
}

describe("BrowserRemoteTabView", () => {
  beforeEach(() => {
    mocks.baseUrl = "https://dev.example.com"
    mocks.openBrowserTab.mockClear()
    mocks.copy.mockClear()
    mocks.toast.success.mockClear()
    mocks.surfaceHost.mockClear()
  })

  it("says the address is on the remote host, and loads nothing", () => {
    renderView("http://localhost:3000/app")
    expect(screen.getByText("This address is on dev.example.com")).toBeVisible()
    expect(
      screen.getByText(/points at the machine this workspace runs on/)
    ).toBeVisible()
    // Nothing was opened on the person's behalf.
    expect(mocks.openBrowserTab).not.toHaveBeenCalled()
  })

  it("copies the address", async () => {
    renderView("http://localhost:3000/app")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }))
    })
    expect(mocks.copy).toHaveBeenCalledWith("http://localhost:3000/app")
    expect(mocks.toast.success).toHaveBeenCalledWith("Address copied")
  })

  // The same page on the remote host's own name: an ordinary tab of this
  // computer, not a remote one (that would just show this card again).
  it("offers the remote host's name for a loopback address with a port", () => {
    renderView("http://localhost:3000/app?x=1#top")
    fireEvent.click(
      screen.getByRole("button", { name: "Try dev.example.com:3000" })
    )
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://dev.example.com:3000/app?x=1#top",
      { remote: false }
    )
  })

  it("puts an IPv6 host in brackets", () => {
    mocks.baseUrl = "https://[fd00::5]:3080"
    renderView("http://127.0.0.1:8080/")
    fireEvent.click(screen.getByRole("button", { name: "Try [fd00::5]:8080" }))
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://[fd00::5]:8080/",
      {
        remote: false,
      }
    )
  })

  // Through an SSH tunnel the server is this machine's loopback: that name is
  // this computer, so there is nothing of the remote host to try or to name.
  it("offers nothing to try when the server is reached through loopback", () => {
    mocks.baseUrl = "http://127.0.0.1:3080"
    renderView("http://localhost:3000/")
    expect(screen.queryByRole("button", { name: /^Try / })).toBeNull()
    expect(screen.getByText("This address is on the remote host")).toBeVisible()
  })

  // Without a port, the remote name's default port is whatever fronts codeg
  // there — not the page the address meant.
  it("has nothing to try for a loopback address without a port", () => {
    renderView("http://localhost/app")
    expect(screen.queryByRole("button", { name: /^Try / })).toBeNull()
  })

  // A private address may well be reachable from here too (same network):
  // the person can decide to open it on this computer.
  it("lets a private address be opened on this computer", () => {
    renderView("http://192.168.1.20:8080/")
    expect(screen.queryByRole("button", { name: /^Try / })).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Open on this computer" })
    )
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://192.168.1.20:8080/",
      { remote: false }
    )
  })

  it("never offers a loopback address to this computer", () => {
    renderView("http://localhost:3000/")
    expect(
      screen.queryByRole("button", { name: "Open on this computer" })
    ).toBeNull()
  })
})

describe("BrowserTabView", () => {
  beforeEach(() => mocks.surfaceHost.mockClear())

  it("shows a remote tab as the remote card, with no native surface", () => {
    renderView("http://localhost:3000/", BrowserTabView)
    expect(screen.getByText("This address is on dev.example.com")).toBeVisible()
    expect(mocks.surfaceHost).not.toHaveBeenCalled()
  })
})
