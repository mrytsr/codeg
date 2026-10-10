import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { GenerativeUiSettings } from "@/lib/api"

const getSettings = vi.fn<() => Promise<GenerativeUiSettings>>()
const setSettings =
  vi.fn<(s: { enabled: boolean }) => Promise<GenerativeUiSettings>>()
const prime = vi.fn()
const invalidateSkills = vi.fn()
const toastError = vi.fn()
const toastWarning = vi.fn()
let broadcast: ((s: GenerativeUiSettings) => void) | null = null
let reconnect: (() => void) | null = null

vi.mock("@/lib/api", () => ({
  getGenerativeUiSettings: () => getSettings(),
  setGenerativeUiSettings: (s: { enabled: boolean }) => setSettings(s),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(
    async (_event: string, handler: (s: GenerativeUiSettings) => void) => {
      broadcast = handler
      return () => {}
    }
  ),
  onTransportReconnect: vi.fn((handler: () => void) => {
    reconnect = handler
    return () => {}
  }),
}))
vi.mock("@/hooks/use-generative-ui-enabled", () => ({
  primeGenerativeUiEnabled: (enabled: boolean) => prime(enabled),
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: () => invalidateSkills(),
}))
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toastError(m),
    warning: (m: string, o?: { description?: string }) =>
      toastWarning(m, o?.description),
  },
}))

import { GenerativeUiBody } from "./generative-ui-settings"

const t = enMessages.GenerativeUiSettings

const settings = (
  enabled: boolean,
  more: Partial<GenerativeUiSettings> = {}
): GenerativeUiSettings => ({
  enabled,
  skill_conflict: false,
  unlink_failures: [],
  ...more,
})

/** What the backend has stored; reads return it and saves change it. */
let stored = false

function renderBody(onRegisterRefresh?: (refresh: () => void) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GenerativeUiBody onRegisterRefresh={onRegisterRefresh} />
    </NextIntlClientProvider>
  )
}

async function readySwitch() {
  const toggle = await screen.findByRole("switch", { name: t.switchLabel })
  await waitFor(() => expect(toggle).toBeEnabled())
  return toggle
}

beforeEach(() => {
  stored = false
  getSettings.mockReset()
  setSettings.mockReset()
  prime.mockClear()
  invalidateSkills.mockClear()
  toastError.mockClear()
  toastWarning.mockClear()
  broadcast = null
  reconnect = null
  getSettings.mockImplementation(async () => settings(stored))
  setSettings.mockImplementation(async ({ enabled }) => {
    stored = enabled
    return settings(enabled)
  })
})
afterEach(() => cleanup())

describe("GenerativeUiBody", () => {
  it("shows the stored switch and how to use it", async () => {
    stored = true
    renderBody()
    const toggle = await readySwitch()
    expect(toggle).toBeChecked()
    expect(screen.getByText(t.usage)).toBeInTheDocument()
    expect(screen.queryByText(t.conflict)).toBeNull()
    // This window's chat follows what was read.
    expect(prime).toHaveBeenLastCalledWith(true)
  })

  it("applies a flip at once, in this window and in its skill lists", async () => {
    const user = userEvent.setup()
    renderBody()
    const toggle = await readySwitch()

    await user.click(toggle)
    expect(setSettings).toHaveBeenCalledWith({ enabled: true })
    await waitFor(() => expect(toggle).toBeChecked())
    await waitFor(() => expect(prime).toHaveBeenLastCalledWith(true))
    expect(invalidateSkills).toHaveBeenCalled()
  })

  it("says so when a skill of the user's holds the name", async () => {
    getSettings.mockResolvedValue(settings(true, { skill_conflict: true }))
    renderBody()
    expect(await screen.findByText(t.conflict)).toBeInTheDocument()
  })

  it("keeps the stored value when a save fails", async () => {
    const user = userEvent.setup()
    setSettings.mockRejectedValue(new Error("disk full"))
    renderBody()
    const toggle = await readySwitch()
    const primedSoFar = prime.mock.calls.length

    await user.click(toggle)
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(t.toasts.saveFailed)
    )
    expect(toggle).not.toBeChecked()
    expect(prime).toHaveBeenCalledTimes(primedSoFar)
  })

  it("warns when a switch-off leaves the skill linked somewhere", async () => {
    const user = userEvent.setup()
    stored = true
    setSettings.mockImplementation(async ({ enabled }) => {
      stored = enabled
      return settings(enabled, {
        unlink_failures: ["/home/u/.claude/skills/json-render: denied"],
      })
    })
    renderBody()
    const toggle = await readySwitch()
    expect(toggle).toBeChecked()

    await user.click(toggle)
    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith(
        t.toasts.unlinkFailed,
        "/home/u/.claude/skills/json-render: denied"
      )
    )
    expect(toggle).not.toBeChecked()
  })

  it("a refresh that read an older value does not undo a broadcast", async () => {
    let refresh: () => void = () => {}
    let resolveRefresh: (s: GenerativeUiSettings) => void = () => {}
    renderBody((fn) => {
      refresh = fn
    })
    const toggle = await readySwitch()

    getSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    // Refresh reads the old value; another window turns it on before the
    // read comes back.
    act(() => refresh())
    act(() => broadcast?.(settings(true)))
    expect(toggle).toBeChecked()
    await act(async () => {
      resolveRefresh(settings(false))
      await Promise.resolve()
    })
    expect(toggle).toBeChecked()
  })

  it("a save's late response gives way to the stored value", async () => {
    const user = userEvent.setup()
    let respond: (s: GenerativeUiSettings) => void = () => {}
    setSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    renderBody()
    const toggle = await readySwitch()

    await user.click(toggle)
    // This save is applied, then another window's switch-off, whose
    // broadcast reaches this window before this save's own response.
    act(() => broadcast?.(settings(false)))
    await act(async () => {
      respond(settings(true))
      await Promise.resolve()
    })
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(prime).toHaveBeenLastCalledWith(false)
  })

  it("a save whose own broadcast is lost still shows once read back", async () => {
    const user = userEvent.setup()
    let respond: (s: GenerativeUiSettings) => void = () => {}
    setSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    renderBody()
    const toggle = await readySwitch()

    await user.click(toggle)
    // An EARLIER save's broadcast arrives, then the connection drops before
    // this save's own broadcast; only its response gets here.
    act(() => broadcast?.(settings(false)))
    stored = true
    await act(async () => {
      respond(settings(true))
      await Promise.resolve()
    })
    await waitFor(() => expect(prime).toHaveBeenLastCalledWith(true))
    expect(toggle).toBeChecked()
  })

  it("reads again after the connection comes back", async () => {
    renderBody()
    const toggle = await readySwitch()
    expect(toggle).not.toBeChecked()

    // Saved elsewhere while this client was disconnected: no broadcast.
    stored = true
    act(() => reconnect?.())
    await waitFor(() => expect(toggle).toBeChecked())
  })
  it("of two overlapping reads, the one that started later stands", async () => {
    let refresh: () => void = () => {}
    let answerRefresh: (s: GenerativeUiSettings) => void = () => {}
    renderBody((fn) => {
      refresh = fn
    })
    const toggle = await readySwitch()

    // A refresh reads the old value and stalls; a broadcast is lost while
    // disconnected; the reconnect's read sees the new value first.
    getSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerRefresh = resolve
        })
    )
    act(() => refresh())
    stored = true
    act(() => reconnect?.())
    await waitFor(() => expect(toggle).toBeChecked())
    await act(async () => {
      answerRefresh(settings(false))
      await Promise.resolve()
    })
    expect(toggle).toBeChecked()
    expect(prime).toHaveBeenLastCalledWith(true)
  })

  it("locks the switch when a save cannot be read back", async () => {
    const user = userEvent.setup()
    renderBody()
    const toggle = await readySwitch()

    getSettings.mockRejectedValueOnce(new Error("connection reset"))
    await user.click(toggle)
    expect(await screen.findByText("connection reset")).toBeInTheDocument()
    expect(toggle).toBeDisabled()

    // The next word of the stored value unlocks it.
    act(() => broadcast?.(settings(true)))
    expect(toggle).toBeEnabled()
    expect(toggle).toBeChecked()
  })
})
