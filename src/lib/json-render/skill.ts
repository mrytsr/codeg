import { jsonRenderCatalog } from "./catalog"

/**
 * The name of the skill Codeg links into an agent's skill directory while
 * generative UI is on. It is what the user types: `/json-render` (`$json-render`
 * in Codex).
 */
export const JSON_RENDER_SKILL_NAME = "json-render"

/** Always in the agent's skill list, so it says what the skill is for and that
 *  it only means something inside Codeg's chat. No backticks: two YAML readers
 *  parse this line (`lib/skill-frontmatter.ts` and the Rust side). */
const DESCRIPTION =
  "Show results as interactive UI inside Codeg's chat (cards, tables, tabs, accordions, badges, progress bars, simple forms) by writing a json-render spec code block in your reply. Use when the user invokes this skill or asks to see something as a card, table, dashboard or other visual layout in Codeg."

/** Prepended to json-render's own guide. */
const SYSTEM =
  "Codeg renders a ```spec code block in your reply as interactive UI inside the chat. Write the block directly in your reply message, never into a file. Use it when a visual layout genuinely helps (comparisons, status or progress summaries, structured results, checklists); answer in plain Markdown otherwise. The format reference follows."

/** Appended to json-render's own rules. The first undoes the guide's advice to
 *  fill a UI with realistic sample data, which is right for a mock-up and wrong
 *  for a report on real work; the second is the chat column. */
const CUSTOM_RULES = [
  "The sample-data rules above apply only to mock-ups the user explicitly asks for. Otherwise show only real data from your work in this session (files, command output, test results); never invent numbers.",
  "The UI renders in a chat column of limited width: keep it compact, and never use viewport-height classes (h-screen, min-h-screen).",
]

/**
 * The `SKILL.md` an agent reads: a frontmatter block, then json-render's
 * official inline-mode guide for the shared catalog.
 *
 * The backend ships the committed copy in `src-tauri/genui/json-render/`;
 * `skill.test.ts` keeps that copy equal to this output, and rewrites it when
 * run with `UPDATE_JSON_RENDER_SKILL=1` (after a json-render upgrade).
 */
export function buildJsonRenderSkill(): string {
  const frontmatter = [
    "---",
    `name: ${JSON_RENDER_SKILL_NAME}`,
    `description: ${DESCRIPTION}`,
    "---",
  ].join("\n")
  const guide = jsonRenderCatalog.prompt({
    mode: "inline",
    system: SYSTEM,
    customRules: CUSTOM_RULES,
  })
  return `${frontmatter}\n${guide}\n`
}
