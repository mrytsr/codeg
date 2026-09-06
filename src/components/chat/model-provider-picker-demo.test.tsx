import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import { ModelProviderPickerDemo } from "./model-provider-picker-demo"
import enMessages from "@/i18n/messages/en.json"

function renderDemo() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ModelProviderPickerDemo />
    </NextIntlClientProvider>
  )
}

describe("ModelProviderPickerDemo", () => {
  it("defaults to the first enabled provider's first model", async () => {
    renderDemo()
    const trigger = await screen.findByRole("button", {
      name: "Demo provider picker",
    })
    expect(within(trigger).getByText("DEMO")).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(trigger).getByText("deepseek · deepseek-chat")
      ).toBeInTheDocument()
    )
  })

  it("shows every provider's models expanded and applies a selection", async () => {
    renderDemo()
    const trigger = await screen.findByRole("button", {
      name: "Demo provider picker",
    })
    fireEvent.click(trigger)

    // Fully expanded: models of every provider are visible without expanding.
    const openrouterModel = await screen.findByText(
      "openrouter/anthropic/claude-sonnet-4-5"
    )
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument()
    expect(screen.queryByText("qwen2.5-72b-instruct")).not.toBeInTheDocument()

    // Group headers are not interactive — no expand/collapse affordance.
    expect(screen.queryByText("OpenRouter gateway")).not.toBeInTheDocument()

    fireEvent.click(openrouterModel)
    await waitFor(() =>
      expect(
        within(trigger).getByText(
          "openrouter · openrouter/anthropic/claude-sonnet-4-5"
        )
      ).toBeInTheDocument()
    )
  })
})
