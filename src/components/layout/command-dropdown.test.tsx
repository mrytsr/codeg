import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  GLOBAL_COMMANDS_STORAGE_KEY,
  createGlobalCommand,
} from "@/lib/global-commands"
import type { FolderCommand } from "@/lib/types"
import {
  commandLinkKey,
  useCommandTerminalLinkStore,
} from "@/stores/command-terminal-link-store"

const mocks = vi.hoisted(() => ({
  activeFolder: { id: 1, path: "/repo", name: "repo" },
  createTerminalWithCommand: vi.fn(async () => "term-1"),
  terminalStop: vi.fn(async () => {}),
  terminalKill: vi.fn(async () => {}),
  listFolderCommands: vi.fn(async () => [] as FolderCommand[]),
  syncFolderCommandsFromPackageJson: vi.fn(async () => [] as FolderCommand[]),
  runLocalCommand: vi.fn(async () => {}),
  toastError: vi.fn(),
  desktop: true,
  remote: true,
  baseUrl: "https://devbox.example:3080",
  terminalTabs: [] as { id: string }[],
}))

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }))

vi.mock("@/lib/transport", () => ({
  isDesktop: () => mocks.desktop,
  isRemoteDesktopMode: () => mocks.remote,
  getServerBaseUrl: () => mocks.baseUrl,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: mocks.activeFolder }),
}))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    createTerminalWithCommand: mocks.createTerminalWithCommand,
    exitedTerminals: new Set<string>(),
    tabs: mocks.terminalTabs,
  }),
}))

vi.mock("@/lib/api", () => ({
  listFolderCommands: mocks.listFolderCommands,
  syncFolderCommandsFromPackageJson: mocks.syncFolderCommandsFromPackageJson,
  runLocalCommand: mocks.runLocalCommand,
  terminalStop: mocks.terminalStop,
  terminalKill: mocks.terminalKill,
}))

vi.mock("./command-manage-dialog", () => ({
  CommandManageDialog: () => null,
}))

import { CommandDropdown } from "./command-dropdown"

const commands = [
  {
    id: 1,
    folder_id: 1,
    name: "dev",
    command: "npm run dev",
    sort_order: 0,
    created_at: "",
    updated_at: "",
  },
  {
    id: 2,
    folder_id: 1,
    name: "build",
    command: "npm run build",
    sort_order: 1,
    created_at: "",
    updated_at: "",
  },
]

const RUN_TITLE = (command: string) =>
  // en.json's runCommandTitle with the command interpolated.
  `Run: ${command}`
const STOP_TITLE = (command: string) => `Stop: ${command}`

function hostCommand(
  id: number,
  command: string,
  runLocal = false
): FolderCommand {
  return {
    id,
    folder_id: 1,
    name: `host-${id}`,
    command,
    sort_order: 0,
    run_local: runLocal,
    created_at: "",
    updated_at: "",
  }
}

function renderDropdown() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CommandDropdown />
    </NextIntlClientProvider>
  )
}

/**
 * jsdom has no PointerEvent constructor, so fireEvent.pointerDown degrades to
 * a propertyless Event whose `button` is undefined — which Radix's
 * `event.button === 0` gate rejects. Build MouseEvents directly instead, the
 * same way use-long-press-action.test.tsx does.
 */
function firePointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX?: number; clientY?: number } = {}
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: 0,
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/**
 * Radix dropdowns open on the trigger's pointerdown (not click), and jsdom
 * synthesizes no pointer stream from fireEvent.click — so open the menu the
 * way a real press does.
 */
async function openMenu() {
  renderDropdown()
  await act(async () => {}) // flush the initial commands load
  firePointer(screen.getByRole("button", { name: "dev" }), "pointerdown")
  await act(async () => {})
  return screen.getByRole("menuitem", { name: /build/ })
}

describe("CommandDropdown menu items", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    useCommandTerminalLinkStore.setState({ links: {} })
    mocks.listFolderCommands.mockResolvedValue(commands)
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue(commands)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("syncs commands from package.json every time the folder loads", async () => {
    vi.useRealTimers()
    renderDropdown()
    await act(async () => {})

    expect(mocks.syncFolderCommandsFromPackageJson).toHaveBeenCalledWith(
      1,
      "/repo"
    )
  })

  it("a short press keeps selecting the command without running it", async () => {
    await openMenu()
    const item = screen.getByRole("menuitem", { name: /build/ })
    firePointer(item, "pointerdown")
    firePointer(item, "pointerup")
    fireEvent.click(item)
    await act(async () => {}) // flush the menu close

    expect(mocks.createTerminalWithCommand).not.toHaveBeenCalled()
    expect(localStorage.getItem("lastCmd:1")).toBe("2")
    // Menu closed and the pill now shows the freshly selected command.
    expect(screen.queryByRole("menuitem", { name: /build/ })).toBeNull()
    expect(screen.getByRole("button", { name: "build" })).toBeInTheDocument()
  })

  it("a long press runs the command directly and closes the menu", async () => {
    await openMenu()
    const item = screen.getByRole("menuitem", { name: /build/ })
    firePointer(item, "pointerdown")
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(mocks.createTerminalWithCommand).toHaveBeenCalledWith(
      "build",
      "npm run build",
      2
    )
    await act(async () => {}) // flush the menu close
    expect(screen.queryByRole("menuitem", { name: /build/ })).toBeNull()
    // Running also selects, so the pill follows the launched command.
    expect(localStorage.getItem("lastCmd:1")).toBe("2")
  })

  it("launches with the command's id, so its tab can find the launcher again", async () => {
    // findByTitle/waitFor poll on real timers; the fake ones above are only
    // for the long-press suite.
    vi.useRealTimers()
    renderDropdown()
    await act(async () => {}) // flush the initial commands load
    fireEvent.click(await screen.findByTitle(RUN_TITLE("npm run dev")))
    await waitFor(() =>
      expect(mocks.createTerminalWithCommand).toHaveBeenCalledWith(
        "dev",
        "npm run dev",
        1
      )
    )
    expect(useCommandTerminalLinkStore.getState().links).toEqual({
      [commandLinkKey(1, 1)]: "term-1",
    })
  })

  it("stops a running command without closing its terminal", async () => {
    vi.useRealTimers()
    // The tab stays open on what the command printed. A plain kill would
    // also forget that output, and a reload of the tab would find nothing.
    mocks.terminalTabs = [{ id: "term-1" }]
    useCommandTerminalLinkStore.setState({
      links: { [commandLinkKey(1, 1)]: "term-1" },
    })
    renderDropdown()
    fireEvent.click(await screen.findByTitle(STOP_TITLE("npm run dev")))
    await waitFor(() =>
      expect(mocks.terminalStop).toHaveBeenCalledWith("term-1")
    )
    expect(mocks.terminalKill).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })
})

describe("CommandDropdown local and global commands", () => {
  beforeEach(() => {
    localStorage.clear()
    useCommandTerminalLinkStore.setState({ links: {} })
    mocks.desktop = true
    mocks.remote = true
    mocks.baseUrl = "https://devbox.example:3080"
    mocks.activeFolder = { id: 1, path: "/repo", name: "repo" }
    mocks.terminalTabs = []
    mocks.createTerminalWithCommand.mockClear()
    mocks.createTerminalWithCommand.mockImplementation(async () => "term-1")
    mocks.runLocalCommand.mockClear()
    mocks.toastError.mockClear()
    mocks.terminalStop.mockClear()
    mocks.terminalKill.mockClear()
  })

  it("runs a local window's command on this machine, in the folder", async () => {
    mocks.remote = false
    mocks.listFolderCommands.mockResolvedValue([
      hostCommand(5, 'open -a Zed "$CODEG_FOLDER_PATH"', true),
    ])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([
      hostCommand(5, 'open -a Zed "$CODEG_FOLDER_PATH"', true),
    ])
    renderDropdown()
    fireEvent.click(
      await screen.findByTitle(RUN_TITLE('open -a Zed "$CODEG_FOLDER_PATH"'))
    )
    await waitFor(() =>
      expect(mocks.runLocalCommand).toHaveBeenCalledWith(
        'open -a Zed "$CODEG_FOLDER_PATH"',
        "/repo",
        null,
        "/repo"
      )
    )
    expect(mocks.createTerminalWithCommand).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("runs a command that merely starts with local: in a terminal", async () => {
    mocks.listFolderCommands.mockResolvedValue([hostCommand(5, "local: zed .")])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([
      hostCommand(5, "local: zed ."),
    ])
    renderDropdown()
    fireEvent.click(await screen.findByTitle(RUN_TITLE("local: zed .")))
    await waitFor(() =>
      expect(mocks.createTerminalWithCommand).toHaveBeenCalledWith(
        "host-5",
        "local: zed .",
        5
      )
    )
    expect(mocks.runLocalCommand).not.toHaveBeenCalled()
  })

  it("runs a remote server's command on this machine like any other", async () => {
    mocks.listFolderCommands.mockResolvedValue([
      hostCommand(5, 'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"', true),
    ])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([
      hostCommand(5, 'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"', true),
    ])
    renderDropdown()
    fireEvent.click(
      await screen.findByTitle(
        RUN_TITLE('zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"')
      )
    )
    await waitFor(() =>
      expect(mocks.runLocalCommand).toHaveBeenCalledWith(
        'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"',
        "/repo",
        "devbox.example",
        null
      )
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.createTerminalWithCommand).not.toHaveBeenCalled()
  })

  it("runs a global command from a remote window on this machine, outside any folder", async () => {
    mocks.listFolderCommands.mockResolvedValue([])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([])
    createGlobalCommand(
      "zed",
      'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"',
      true
    )
    renderDropdown()
    fireEvent.click(
      await screen.findByTitle(
        RUN_TITLE('zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"')
      )
    )
    await waitFor(() =>
      expect(mocks.runLocalCommand).toHaveBeenCalledWith(
        'zed "ssh://$CODEG_REMOTE_HOST$CODEG_FOLDER_PATH"',
        "/repo",
        "devbox.example",
        null
      )
    )
    expect(mocks.createTerminalWithCommand).not.toHaveBeenCalled()
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("still tells the backend the folder is remote when its host can't be read", async () => {
    // The backend checks a remote folder's path before cmd.exe splices it in.
    mocks.baseUrl = "not a url"
    mocks.listFolderCommands.mockResolvedValue([])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([])
    createGlobalCommand("open", "echo %CODEG_FOLDER_PATH%", true)
    renderDropdown()
    fireEvent.click(
      await screen.findByTitle(RUN_TITLE("echo %CODEG_FOLDER_PATH%"))
    )
    await waitFor(() =>
      expect(mocks.runLocalCommand).toHaveBeenCalledWith(
        "echo %CODEG_FOLDER_PATH%",
        "/repo",
        "",
        null
      )
    )
  })

  it("refuses a command set to run on this computer outside the desktop app", async () => {
    mocks.desktop = false
    mocks.remote = false
    mocks.listFolderCommands.mockResolvedValue([hostCommand(5, "zed .", true)])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([
      hostCommand(5, "zed .", true),
    ])
    renderDropdown()
    fireEvent.click(await screen.findByTitle(RUN_TITLE("zed .")))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Local commands are only available in the desktop app"
      )
    )
    expect(mocks.runLocalCommand).not.toHaveBeenCalled()
    expect(mocks.createTerminalWithCommand).not.toHaveBeenCalled()
  })

  it("doesn't let the host pass a command off as one kept on this computer", async () => {
    // Global commands have negative ids; the host's database never does.
    mocks.listFolderCommands.mockResolvedValue([
      hostCommand(-1, "echo from-the-host", true),
    ])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([
      hostCommand(-1, "echo from-the-host", true),
    ])
    createGlobalCommand("mine", "echo mine", true)
    renderDropdown()
    fireEvent.click(await screen.findByTitle(RUN_TITLE("echo mine")))
    await waitFor(() => expect(mocks.runLocalCommand).toHaveBeenCalledTimes(1))
    expect(mocks.runLocalCommand).toHaveBeenCalledWith(
      "echo mine",
      "/repo",
      "devbox.example",
      null
    )
  })

  it("keeps a global command's run in one folder out of the others", async () => {
    mocks.listFolderCommands.mockResolvedValue([])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([])
    createGlobalCommand("dev", "pnpm dev", false)
    mocks.createTerminalWithCommand.mockImplementationOnce(
      async () => "terminal-a"
    )
    const { rerender } = renderDropdown()
    fireEvent.click(await screen.findByTitle(RUN_TITLE("pnpm dev")))
    await waitFor(() =>
      expect(mocks.createTerminalWithCommand).toHaveBeenCalledTimes(1)
    )
    mocks.terminalTabs = [{ id: "terminal-a" }]
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommandDropdown />
      </NextIntlClientProvider>
    )
    await screen.findByTitle(STOP_TITLE("pnpm dev"))

    // Folder 2 never ran it: it offers to, and runs its own copy.
    mocks.activeFolder = { id: 2, path: "/other", name: "other" }
    mocks.createTerminalWithCommand.mockImplementationOnce(
      async () => "terminal-b"
    )
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommandDropdown />
      </NextIntlClientProvider>
    )
    fireEvent.click(await screen.findByTitle(RUN_TITLE("pnpm dev")))
    await waitFor(() =>
      expect(mocks.createTerminalWithCommand).toHaveBeenCalledTimes(2)
    )
    mocks.terminalTabs = [{ id: "terminal-a" }, { id: "terminal-b" }]
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommandDropdown />
      </NextIntlClientProvider>
    )

    // Stopping it there leaves folder 1's run alone.
    fireEvent.click(await screen.findByTitle(STOP_TITLE("pnpm dev")))
    await waitFor(() =>
      expect(mocks.terminalStop).toHaveBeenCalledWith("terminal-b")
    )
    expect(useCommandTerminalLinkStore.getState().links).toEqual({
      [`${1}:${-1}`]: "terminal-a",
    })
  })

  it("picks up global commands another window added", async () => {
    mocks.listFolderCommands.mockResolvedValue([])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([])
    renderDropdown()
    await screen.findByText("Add Command")

    // Another window writes the store; this one only hears the event.
    createGlobalCommand("zed", "zed .", true)
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: GLOBAL_COMMANDS_STORAGE_KEY })
      )
    })
    fireEvent.click(await screen.findByTitle(RUN_TITLE("zed .")))
    await waitFor(() =>
      expect(mocks.runLocalCommand).toHaveBeenCalledWith(
        "zed .",
        "/repo",
        "devbox.example",
        null
      )
    )
  })

  it("drops global commands when another window clears the storage", async () => {
    mocks.listFolderCommands.mockResolvedValue([])
    mocks.syncFolderCommandsFromPackageJson.mockResolvedValue([])
    createGlobalCommand("zed", "zed .", true)
    renderDropdown()
    await screen.findByTitle(RUN_TITLE("zed ."))

    // `clear()` reaches other windows as a storage event with no key.
    localStorage.clear()
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(await screen.findByText("Add Command")).toBeInTheDocument()
  })
})
