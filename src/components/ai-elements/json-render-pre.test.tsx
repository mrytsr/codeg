import { render, screen, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

const genui = vi.hoisted(() => ({ enabled: true }))
vi.mock("@/hooks/use-generative-ui-enabled", () => ({
  useGenerativeUiEnabled: () => genui.enabled,
}))

import { JsonRenderScope } from "./json-render-pre"
import { MessageResponse } from "./message"

// The REAL Streamdown and the real json-render chunk: what is under test is
// which fences reach the card and which stay code, and that only shows up
// end to end.

const line = (patch: object) => JSON.stringify(patch)
const ROOT = line({ op: "add", path: "/root", value: "main" })
const CARD = line({
  op: "add",
  path: "/elements/main",
  value: {
    type: "Card",
    props: { title: "Release status" },
    children: ["note"],
  },
})
const NOTE = line({
  op: "add",
  path: "/elements/note",
  value: { type: "Text", props: { text: "All checks passed" } },
})
const fence = (body: string, language = "spec") =>
  `Here it is:\n\n\`\`\`${language}\n${body}\n\`\`\`\n`
const SPEC = fence([ROOT, CARD, NOTE].join("\n"))

function reply(text: string, mode?: "streaming" | "static") {
  return (
    <JsonRenderScope>
      <MessageResponse
        mode={mode}
        parseIncompleteMarkdown={mode === "streaming"}
      >
        {text}
      </MessageResponse>
    </JsonRenderScope>
  )
}

const card = (container: HTMLElement) =>
  container.querySelector("[data-json-render]")

beforeEach(() => {
  genui.enabled = true
})

// Load the card's chunk once up front. A fence the card claims would
// otherwise show its code (the Suspense fallback) for a moment, and the
// "stays code" checks below could pass on that moment alone. Under a full,
// loaded run the chunk's first import can take seconds, so it is imported
// here first and given time.
beforeAll(async () => {
  await import("@/components/message/json-render-block")
  const { container, unmount } = render(reply(SPEC))
  await waitFor(() => expect(card(container)).not.toBeNull(), {
    timeout: 10_000,
  })
  unmount()
}, 30_000)

describe("spec fences in messages", () => {
  it("render as json-render UI in an assistant reply", async () => {
    const { container } = render(reply(SPEC))
    await waitFor(() =>
      expect(screen.getByText("All checks passed")).toBeInTheDocument()
    )
    expect(screen.getByText("Release status")).toBeInTheDocument()
    expect(card(container)).not.toBeNull()
    expect(container.textContent).not.toContain('"op"')
  })

  it("stay code outside an assistant reply", async () => {
    const { container } = render(<MessageResponse>{SPEC}</MessageResponse>)
    await waitFor(() => expect(container.textContent).toContain('"op"'))
    expect(card(container)).toBeNull()
  })

  it("stay code while generative UI is off", async () => {
    genui.enabled = false
    const { container } = render(reply(SPEC))
    await waitFor(() => expect(container.textContent).toContain('"op"'))
    expect(card(container)).toBeNull()
  })

  it("leave an RPM spec file and other fences alone", async () => {
    const rpm = fence("Name: hello\nVersion: 1.0")
    const ts = fence("const answer = 42", "ts")
    const { container } = render(reply(`${rpm}\n${ts}`))
    await waitFor(() => {
      expect(container.textContent).toContain("Name: hello")
      expect(container.textContent).toContain("const answer = 42")
    })
    expect(card(container)).toBeNull()
  })

  it("stay code when an element is its own descendant", async () => {
    const cyclic = fence(
      [
        ROOT,
        line({
          op: "add",
          path: "/elements/main",
          value: { type: "Card", props: { title: "Loop" }, children: ["x"] },
        }),
        line({
          op: "add",
          path: "/elements/x",
          value: { type: "Stack", props: {}, children: ["main"] },
        }),
      ].join("\n")
    )
    const { container } = render(reply(cyclic))
    await waitFor(() => expect(container.textContent).toContain('"op"'))
    expect(card(container)).toBeNull()
  })

  it("fall back to code, not a blank window, when the renderer throws", async () => {
    // Passes compiling and the cycle check; json-render then reads the
    // null `elements` and throws.
    const broken = fence(
      [
        ROOT,
        CARD,
        line({ op: "replace", path: "/elements", value: null }),
      ].join("\n")
    )
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const { container } = render(reply(broken))
    await waitFor(() => expect(container.textContent).toContain('"op"'))
    expect(container.textContent).toContain("Here it is:")
    expect(card(container)).toBeNull()
    errors.mockRestore()
  })

  it("grow while the reply streams, from the first line on", async () => {
    const onlyRoot = `Here it is:\n\n\`\`\`spec\n${ROOT}\n`
    const { container, rerender } = render(reply(onlyRoot, "streaming"))
    await waitFor(() => expect(card(container)).not.toBeNull())
    expect(screen.queryByText("Release status")).toBeNull()

    // The card has arrived; its child is still half a line.
    const halfway = `Here it is:\n\n\`\`\`spec\n${ROOT}\n${CARD}\n${NOTE.slice(0, 40)}`
    rerender(reply(halfway, "streaming"))
    await waitFor(() =>
      expect(screen.getByText("Release status")).toBeInTheDocument()
    )
    expect(screen.queryByText("All checks passed")).toBeNull()

    rerender(reply(SPEC, "static"))
    await waitFor(() =>
      expect(screen.getByText("All checks passed")).toBeInTheDocument()
    )
  })
})
