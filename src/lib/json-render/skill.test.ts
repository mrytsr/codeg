import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { buildJsonRenderSkill, JSON_RENDER_SKILL_NAME } from "./skill"

// The copy the backend compiles in (`include_str!` in
// `src-tauri/src/commands/generative_ui.rs`) and installs for agents.
const COMMITTED = resolve(process.cwd(), "src-tauri/genui/json-render/SKILL.md")

describe("json-render skill", () => {
  it("the committed SKILL.md is what the catalog generates", () => {
    const generated = buildJsonRenderSkill()
    // After a json-render upgrade: UPDATE_JSON_RENDER_SKILL=1 pnpm test skill
    if (process.env.UPDATE_JSON_RENDER_SKILL) {
      writeFileSync(COMMITTED, generated)
    }
    expect(readFileSync(COMMITTED, "utf8")).toBe(generated)
  })

  it("names itself after the directory it is installed under", () => {
    const head = buildJsonRenderSkill().split("\n").slice(0, 4)
    expect(head[0]).toBe("---")
    expect(head[1]).toBe(`name: ${JSON_RENDER_SKILL_NAME}`)
    expect(head[2]).toMatch(/^description: [^`]+$/)
    expect(head[3]).toBe("---")
  })
})
