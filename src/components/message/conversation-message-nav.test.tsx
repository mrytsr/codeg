import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { RefObject } from "react"
import {
  ConversationMessageNav,
  type MessageNavEntry,
} from "./conversation-message-nav"
import type { MessageScrollContextValue } from "./message-scroll-context"
import { ChatAnimationsContext } from "@/components/appearance-provider"

// Stable `t` (per next-intl mock guidance) — returns the key verbatim, which is
// enough to address every label in this component (the collapsed chip, the card
// title/collapse button, the per-entry file-count toggle, etc.).
const { stableT, mockOpenDiff } = vi.hoisted(() => {
  const t = (key: string) => key
  return { stableT: t, mockOpenDiff: vi.fn() }
})

vi.mock("next-intl", () => ({ useTranslations: () => stableT }))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openSessionFileDiff: mockOpenDiff }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { path: "/repo" } }),
}))

const DELETION_DIFF = "*** Delete File: old.ts\n-a\n-b\n-c\n-d"

const entries: MessageNavEntry[] = [
  {
    threadIndex: 0,
    turnId: "u1",
    ordinal: 1,
    label: "first message",
    additions: 0,
    deletions: 0,
    files: [],
    hasChanges: false,
  },
  {
    // One-sided change: additions only — the -0 must still render.
    threadIndex: 3,
    turnId: "u2",
    ordinal: 2,
    label: "edit something",
    additions: 5,
    deletions: 0,
    files: [
      {
        id: "f1",
        path: "/repo/src/a.ts",
        additions: 5,
        deletions: 0,
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+new",
      },
    ],
    hasChanges: true,
  },
  {
    // Deleted file — must remain clickable to open its deletion diff.
    threadIndex: 6,
    turnId: "u3",
    ordinal: 3,
    label: "delete a file",
    additions: 0,
    deletions: 4,
    files: [
      {
        id: "f2",
        path: "/repo/old.ts",
        additions: 0,
        deletions: 4,
        diff: DELETION_DIFF,
      },
    ],
    hasChanges: true,
  },
]

function makeScrollApi() {
  const scrollToIndex = vi.fn()
  const scrollApiRef = {
    current: { scrollToIndex },
  } as RefObject<MessageScrollContextValue | null>
  return { scrollToIndex, scrollApiRef }
}

describe("ConversationMessageNav", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders nothing when there are no user messages", () => {
    const { scrollApiRef } = makeScrollApi()
    const { container } = render(
      <ConversationMessageNav
        count={0}
        expanded={false}
        onToggle={vi.fn()}
        entries={[]}
        scrollApiRef={scrollApiRef}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("collapsed: shows the count chip and expands on click", () => {
    const { scrollApiRef } = makeScrollApi()
    const onToggle = vi.fn()
    render(
      <ConversationMessageNav
        count={3}
        expanded={false}
        onToggle={onToggle}
        entries={[]}
        scrollApiRef={scrollApiRef}
      />
    )
    // No card while collapsed.
    expect(screen.queryByText("title")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "collapsedSummary" }))
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it("expanded: clicking a message scrolls to its thread index", () => {
    const { scrollToIndex, scrollApiRef } = makeScrollApi()
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        scrollApiRef={scrollApiRef}
      />
    )
    fireEvent.click(screen.getByText("edit something"))
    expect(scrollToIndex).toHaveBeenCalledWith(3, {
      align: "start",
      smooth: true,
    })
  })

  it("expanded: jumps without gliding when chat animations are off", () => {
    const { scrollToIndex, scrollApiRef } = makeScrollApi()
    render(
      <ChatAnimationsContext.Provider value={false}>
        <ConversationMessageNav
          count={entries.length}
          expanded
          onToggle={vi.fn()}
          entries={entries}
          scrollApiRef={scrollApiRef}
        />
      </ChatAnimationsContext.Provider>
    )
    fireEvent.click(screen.getByText("edit something"))
    expect(scrollToIndex).toHaveBeenCalledWith(3, {
      align: "start",
      smooth: false,
    })
  })

  it("expanded: the header collapse button collapses the panel", () => {
    const { scrollApiRef } = makeScrollApi()
    const onToggle = vi.fn()
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={onToggle}
        entries={entries}
        scrollApiRef={scrollApiRef}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "collapse" }))
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it("always shows both +N and -N, including a zero side", () => {
    const { scrollApiRef } = makeScrollApi()
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        scrollApiRef={scrollApiRef}
      />
    )
    // u2 added 5, deleted 0 — both rendered.
    expect(screen.getByText("+5")).toBeInTheDocument()
    expect(screen.getByText("-0")).toBeInTheDocument()
    // u3 added 0, deleted 4 — both rendered.
    expect(screen.getByText("+0")).toBeInTheDocument()
    expect(screen.getByText("-4")).toBeInTheDocument()
    // Placeholder message still renders its label.
    expect(screen.getByText("first message")).toBeInTheDocument()
  })

  it("opens a file diff when a changed file is clicked", () => {
    const { scrollApiRef } = makeScrollApi()
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        scrollApiRef={scrollApiRef}
      />
    )
    // Expand u2's file list (first changed group).
    fireEvent.click(screen.getAllByRole("button", { name: "fileCount" })[0])
    fireEvent.click(screen.getByTitle("src/a.ts"))
    expect(mockOpenDiff).toHaveBeenCalledWith(
      "/repo/src/a.ts",
      "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+new",
      "msg-2-chg-1"
    )
  })

  it("opens the deletion diff when a deleted file is clicked", () => {
    const { scrollApiRef } = makeScrollApi()
    render(
      <ConversationMessageNav
        count={entries.length}
        expanded
        onToggle={vi.fn()}
        entries={entries}
        scrollApiRef={scrollApiRef}
      />
    )
    // Expand u3's file list (second changed group).
    fireEvent.click(screen.getAllByRole("button", { name: "fileCount" })[1])
    fireEvent.click(screen.getByTitle("old.ts"))
    expect(mockOpenDiff).toHaveBeenCalledWith(
      "/repo/old.ts",
      DELETION_DIFF,
      "msg-3-chg-1"
    )
  })
})
