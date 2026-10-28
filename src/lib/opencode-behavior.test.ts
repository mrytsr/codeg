import { describe, expect, it } from "vitest"

import { parseJsoncObject } from "./jsonc-edit"
import {
  readOpenCodeBehavior,
  removeIgnoredLegacyKeys,
  setOpenCodeDefaultAgent,
  setOpenCodeNumber,
  setOpenCodeToggle,
  setOpenCodeUpdate,
} from "./opencode-behavior"

const parse = (text: string) => parseJsoncObject(text).value

describe("readOpenCodeBehavior", () => {
  it("reads every OpenCode 2 field out of a full document", () => {
    const view = readOpenCodeBehavior(
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        default_agent: "plan",
        update: "notify",
        snapshots: false,
        compaction: { auto: false, keep: { tokens: 20000 }, buffer: 10000 },
        tool_output: { max_lines: 500, max_bytes: 1024 },
        experimental: {
          todo: true,
          background_compaction: true,
          subagent_depth: 2,
        },
      })
    )
    expect(view).toEqual({
      defaultAgent: "plan",
      update: "notify",
      invalid: false,
      ignoredLegacyKeys: [],
      toggles: {
        snapshots: false,
        "compaction.auto": false,
        "experimental.todo": true,
        "experimental.background_compaction": true,
      },
      numbers: {
        "experimental.subagent_depth": 2,
        "compaction.keep.tokens": 20000,
        "compaction.buffer": 10000,
        "tool_output.max_lines": 500,
        "tool_output.max_bytes": 1024,
      },
    })
  })

  it("falls back to the 1.x spellings OpenCode 2 still loads", () => {
    const view = readOpenCodeBehavior(
      JSON.stringify({
        autoupdate: false,
        snapshot: false,
        compaction: { preserve_recent_tokens: 9000, reserved: 7000 },
      })
    )
    expect(view.update).toBe("disable")
    expect(view.toggles.snapshots).toBe(false)
    expect(view.numbers["compaction.keep.tokens"]).toBe(9000)
    expect(view.numbers["compaction.buffer"]).toBe(7000)

    // The 2.x key wins where both are set, as in OpenCode's normalizer.
    const both = readOpenCodeBehavior(
      JSON.stringify({
        autoupdate: true,
        update: "disable",
        snapshot: true,
        snapshots: false,
      })
    )
    expect(both.update).toBe("disable")
    expect(both.toggles.snapshots).toBe(false)
  })

  it("lists the 1.x keys OpenCode 2 does not act on", () => {
    const view = readOpenCodeBehavior(
      JSON.stringify({
        share: "auto",
        subagent_depth: 3,
        compaction: { prune: true, tail_turns: 4 },
      })
    )
    expect(view.ignoredLegacyKeys).toEqual([
      "subagent_depth",
      "compaction.tail_turns",
      "compaction.prune",
      "share",
    ])
    // A top-level subagent_depth is dropped, not read as the depth.
    expect(view.numbers["experimental.subagent_depth"]).toBeNull()
  })

  it("reports every field unset for an empty document and locks on bad text", () => {
    const empty = readOpenCodeBehavior("")
    expect(empty.invalid).toBe(false)
    expect(empty.update).toBeNull()
    expect(Object.values(empty.toggles).every((v) => v === null)).toBe(true)
    expect(readOpenCodeBehavior("{ nope").invalid).toBe(true)
  })

  it("reads a document with comments", () => {
    const view = readOpenCodeBehavior(
      '{\n  // keep\n  "experimental": { "todo": true, },\n}\n'
    )
    expect(view.toggles["experimental.todo"]).toBe(true)
  })
})

describe("writers", () => {
  it("writes update and drops 1.x's autoupdate", () => {
    const out = setOpenCodeUpdate('{"autoupdate": true}', "notify")
    expect(parse(out)).toEqual({ update: "notify" })
    expect(parse(setOpenCodeUpdate(out, null))).toEqual({})
  })

  it("writes toggles at their 2.x path, removing the 1.x spelling", () => {
    const out = setOpenCodeToggle('{"snapshot": true}', "snapshots", false)
    expect(parse(out)).toEqual({ snapshots: false })
    const todo = setOpenCodeToggle(out, "experimental.todo", true)
    expect(parse(todo)).toEqual({
      snapshots: false,
      experimental: { todo: true },
    })
    // Unsetting prunes the emptied parent.
    expect(parse(setOpenCodeToggle(todo, "experimental.todo", null))).toEqual({
      snapshots: false,
    })
  })

  it("writes numbers at their 2.x path and validates the floor", () => {
    const start = JSON.stringify({
      subagent_depth: 4,
      compaction: { auto: true, preserve_recent_tokens: 1, reserved: 2 },
    })
    const depth = setOpenCodeNumber(start, "experimental.subagent_depth", 2)
    // Setting the 2.x key removes the ignored top-level one.
    expect(parse(depth)).toEqual({
      compaction: { auto: true, preserve_recent_tokens: 1, reserved: 2 },
      experimental: { subagent_depth: 2 },
    })
    const keep = setOpenCodeNumber(depth, "compaction.keep.tokens", 5000)
    expect(parse(keep)).toMatchObject({
      compaction: { auto: true, reserved: 2, keep: { tokens: 5000 } },
    })
    const buffer = setOpenCodeNumber(keep, "compaction.buffer", null)
    expect(parse(buffer)).toEqual({
      compaction: { auto: true, keep: { tokens: 5000 } },
      experimental: { subagent_depth: 2 },
    })
    // Below the floor, or not an integer: untouched.
    expect(setOpenCodeNumber(buffer, "tool_output.max_lines", 0)).toBe(buffer)
    expect(setOpenCodeNumber(buffer, "compaction.buffer", 1.5)).toBe(buffer)
  })

  it("keeps comments and leaves unparsable text alone", () => {
    const text = '{\n  // my agent\n  "default_agent": "build",\n}\n'
    const out = setOpenCodeDefaultAgent(text, "plan")
    expect(out).toContain("// my agent")
    expect(parse(out)).toEqual({ default_agent: "plan" })
    expect(setOpenCodeDefaultAgent("{ nope", "plan")).toBe("{ nope")
  })

  it("removes the ignored 1.x keys on request", () => {
    const out = removeIgnoredLegacyKeys(
      JSON.stringify({
        share: "auto",
        subagent_depth: 3,
        compaction: { prune: true, tail_turns: 4, auto: false },
        model: "a/b",
      })
    )
    expect(parse(out)).toEqual({ compaction: { auto: false }, model: "a/b" })
  })
})
