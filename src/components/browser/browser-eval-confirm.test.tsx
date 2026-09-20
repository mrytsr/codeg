import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  BROWSER_EVAL_REQUEST_EVENT,
  type BrowserEvalRequestPayload,
} from "@/lib/browser/types"

const mocks = vi.hoisted(() => ({
  decide: vi.fn(() => Promise.resolve(true)),
  windowLabel: "main" as string,
  handlers: new Map<string, (payload: unknown) => void>(),
}))
vi.mock("@/lib/browser/browser-api", () => ({
  browserEvalDecide: mocks.decide,
}))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => mocks.windowLabel,
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => true,
  getTransport: () => ({
    subscribe: (event: string, handler: (payload: unknown) => void) => {
      mocks.handlers.set(event, handler)
      return Promise.resolve(() => mocks.handlers.delete(event))
    },
  }),
}))

import { BrowserEvalConfirm } from "./browser-eval-confirm"

function request(
  over: Partial<BrowserEvalRequestPayload> = {}
): BrowserEvalRequestPayload {
  return {
    requestId: "r1",
    tabId: "t1",
    ownerWindow: "main",
    origin: "http://127.0.0.1:8790",
    title: "Dashboard",
    code: "return document.querySelectorAll('.row').length",
    expiresAt: Date.now() + 120_000,
    ...over,
  }
}

/** Deliver one `browser://eval-request` the way the backend broadcasts it. */
async function ask(payload: BrowserEvalRequestPayload) {
  await act(async () => {
    mocks.handlers.get(BROWSER_EVAL_REQUEST_EVENT)?.(payload)
  })
}

function renderConfirm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserEvalConfirm />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.windowLabel = "main"
})

afterEach(() => {
  vi.useRealTimers()
})

describe("BrowserEvalConfirm", () => {
  /** Nothing on screen until something asks — the component is mounted for
   *  the whole session and must be invisible for all of it. */
  it("shows nothing until a snippet is waiting", async () => {
    renderConfirm()
    await act(async () => {})
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  /** What the dialog is FOR is that the person reads the code, so it is there
   *  in full and character for character — not summarised, not elided. */
  it("puts the whole snippet and the site in front of the person", async () => {
    renderConfirm()
    await act(async () => {})
    const code =
      "const rows = [...document.querySelectorAll('tr')]\nreturn rows.length"
    await ask(request({ code }))

    const dialog = screen.getByRole("alertdialog")
    // The site is named in the question itself, not only in the small print.
    expect(
      screen.getByRole("heading", { name: /127\.0\.0\.1:8790/ })
    ).toBeInTheDocument()
    // Character for character, newlines included: the person is agreeing to
    // all of it, so none of it may be normalised away on the way to them.
    expect(dialog.querySelector("pre code")?.textContent).toBe(code)
    // And that this answer is for this snippet only.
    expect(screen.getByText(/every snippet/i)).toBeInTheDocument()
  })

  it("sends the approval for the snippet that was shown", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r7" }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run it once" }))
    })
    expect(mocks.decide).toHaveBeenCalledWith("r7", true)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("sends a refusal when the person says no", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r8" }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Don’t run it" }))
    })
    expect(mocks.decide).toHaveBeenCalledWith("r8", false)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  /** Escape is the same as pressing "don't run": dismissing a dialog you did
   *  not read must never be the permissive answer. */
  it("reads a dismissal as a refusal", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r9" }))

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" })
    })
    expect(mocks.decide).toHaveBeenCalledWith("r9", false)
  })

  /** Running out of time is a refusal too, and it is said out loud rather
   *  than left for the backend's own longer wait to conclude. */
  it("refuses on its own when nobody answers", async () => {
    vi.useFakeTimers()
    renderConfirm()
    await act(async () => {})
    await ask(request({ requestId: "r10", expiresAt: Date.now() + 2000 }))
    expect(screen.getByRole("alertdialog")).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(mocks.decide).toHaveBeenCalledWith("r10", false)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  /** Broadcast to every window, shown by one. Two dialogs would be two
   *  chances to answer, and only the first answer would count. */
  it("is raised only by the window that owns the tab", async () => {
    mocks.windowLabel = "settings"
    renderConfirm()
    await act(async () => {})
    await ask(request({ ownerWindow: "main" }))

    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(mocks.decide).not.toHaveBeenCalled()
  })

  /** A tab with no title falls back to naming the site alone rather than
   *  showing an empty pair of quotes. */
  it("names the site when the page has no title", async () => {
    renderConfirm()
    await act(async () => {})
    await ask(request({ title: "" }))

    expect(screen.queryByText(/“”/)).toBeNull()
    expect(
      screen.getByText(/anything on 127\.0\.0\.1:8790 that you can/)
    ).toBeInTheDocument()
  })
})
