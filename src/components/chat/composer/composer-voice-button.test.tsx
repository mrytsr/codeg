import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { VoicePartialEvent } from "@/lib/api"
import enMessages from "@/i18n/messages/en.json"

import {
  ComposerVoiceButton,
  type ComposerVoiceButtonProps,
} from "./composer-voice-button"

const MI = enMessages.Folder.chat.messageInput

const voiceApi = vi.hoisted(() => ({
  cancelVoiceStream: vi.fn(),
  ensureVoiceReady: vi.fn(),
  getVoiceStatus: vi.fn(),
  getVoiceStreamStatus: vi.fn(),
  listenVoicePartial: vi.fn(),
  listenVoicePrepare: vi.fn(),
  prepareVoiceStream: vi.fn(),
  sendVoiceStreamChunk: vi.fn(),
  startVoiceStream: vi.fn(),
  stopVoiceStream: vi.fn(),
  transcribeVoice: vi.fn(),
}))

const getUserMedia = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api", () => voiceApi)
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), loading: vi.fn(), success: vi.fn() },
}))
vi.mock("@/lib/voice-input", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-input")>()
  // Same observable first await as the real recorder: the getUserMedia mock
  // decides whether starting the mic succeeds or throws NotAllowedError, so
  // both the denial path and the live-streaming path stay reachable.
  class StubLocalPcmRecorder {
    async start() {
      await getUserMedia({ audio: true })
    }
    async stop(): Promise<ArrayBuffer | null> {
      return null
    }
    cancel() {}
  }
  return { ...actual, LocalPcmRecorder: StubLocalPcmRecorder }
})

function renderVoiceButton(props: Partial<ComposerVoiceButtonProps> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerVoiceButton onTranscript={vi.fn()} {...props} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  // WKWebView may expose this even though its speech service cannot start.
  vi.stubGlobal("webkitSpeechRecognition", class {})
  vi.stubGlobal("AudioContext", class {})
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    userAgent: "",
    mediaDevices: { getUserMedia },
  })
  getUserMedia
    .mockReset()
    .mockRejectedValue(new DOMException("", "NotAllowedError"))
  voiceApi.cancelVoiceStream.mockReset().mockResolvedValue({ cancelled: true })
  voiceApi.ensureVoiceReady.mockReset()
  voiceApi.getVoiceStatus.mockReset().mockResolvedValue({
    available: true,
    binary: null,
    model: null,
    reason: null,
    needsManualInstall: false,
  })
  voiceApi.getVoiceStreamStatus.mockReset().mockResolvedValue({
    available: true,
    loaded: true,
    modelDir: "/models/streaming",
    reason: null,
  })
  voiceApi.listenVoicePartial.mockReset().mockResolvedValue(() => {})
  voiceApi.listenVoicePrepare.mockReset().mockResolvedValue(() => {})
  voiceApi.prepareVoiceStream.mockReset()
  voiceApi.sendVoiceStreamChunk.mockReset()
  voiceApi.startVoiceStream
    .mockReset()
    .mockResolvedValue({ sessionId: "stream-1" })
  voiceApi.stopVoiceStream.mockReset()
  voiceApi.transcribeVoice.mockReset()
  vi.mocked(toast.error).mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ComposerVoiceButton on Tauri macOS", () => {
  it("starts local streaming and explains a microphone permission denial", async () => {
    renderVoiceButton()

    expect(
      screen.queryByRole("button", { name: MI.voiceSwitchEngine })
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: MI.voiceStart }))

    await waitFor(() => {
      expect(voiceApi.startVoiceStream).toHaveBeenCalledTimes(1)
      expect(toast.error).toHaveBeenCalledWith(MI.voicePermissionDenied)
    })
    expect(voiceApi.cancelVoiceStream).toHaveBeenCalledWith("stream-1")
  })

  it("streams live partials of the active session to onPartial", async () => {
    let partialListener: ((event: VoicePartialEvent) => void) | null = null
    voiceApi.listenVoicePartial.mockImplementation((cb) => {
      partialListener = cb
      return Promise.resolve(() => {})
    })
    getUserMedia.mockResolvedValue(undefined)
    const onPartial = vi.fn()
    renderVoiceButton({ onPartial })

    await userEvent.click(screen.getByRole("button", { name: MI.voiceStart }))
    // `listening` is only reachable once the streaming session id is stored,
    // so partials fired after this gate hit the live session filter.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: MI.voiceStop })
      ).toBeInTheDocument()
    })

    const fire = (event: VoicePartialEvent) => {
      act(() => {
        if (partialListener) partialListener(event)
      })
    }
    fire({ isFinal: false, sessionId: "stream-1", text: "你好" })
    fire({ isFinal: false, sessionId: "stream-1", text: "你好世界" })
    expect(onPartial).toHaveBeenCalledTimes(2)
    expect(onPartial).toHaveBeenNthCalledWith(2, "你好世界", "stream-1")

    onPartial.mockClear()
    fire({ isFinal: false, sessionId: "stream-9", text: "stale session" })
    fire({ isFinal: true, sessionId: "stream-1", text: "final marker" })
    expect(onPartial).not.toHaveBeenCalled()
  })

  it("streams web-speech interim results live and settles on final", async () => {
    const instances: FakeSpeechRecognition[] = []
    class FakeSpeechRecognition {
      lang = ""
      continuous = false
      interimResults = false
      maxAlternatives = 1
      onresult:
        | ((event: {
            resultIndex: number
            results: {
              length: number
              [index: number]: {
                length: number
                isFinal: boolean
                0: { transcript: string }
              }
            }
          }) => void)
        | null = null
      onerror: ((event: { error: string }) => void) | null = null
      onend: (() => void) | null = null
      start() {
        instances.push(this)
      }
      stop() {}
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition)
    // Not macOS Tauri, so the WKWebView guard lets the fake ctor through.
    vi.stubGlobal("navigator", {
      platform: "Win32",
      userAgent: "",
      mediaDevices: { getUserMedia },
    })
    const onPartial = vi.fn()
    const onTranscript = vi.fn()
    renderVoiceButton({ onPartial, onTranscript })

    await userEvent.click(screen.getByRole("button", { name: MI.voiceStart }))
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: MI.voiceStop })
      ).toBeInTheDocument()
    })
    expect(instances).toHaveLength(1)
    expect(instances[0].interimResults).toBe(true)

    const fire = (transcript: string, isFinal: boolean) => {
      act(() => {
        instances[0].onresult?.({
          resultIndex: 0,
          results: {
            length: 1,
            0: { length: 1, isFinal, 0: { transcript } },
          },
        })
      })
    }
    fire(" 你好 ", false)
    fire(" 你好世界 ", false)
    expect(onPartial).toHaveBeenCalledTimes(2)
    expect(onPartial).toHaveBeenNthCalledWith(1, "你好", "web-1")
    expect(onPartial).toHaveBeenNthCalledWith(2, "你好世界", "web-1")

    fire("你好世界", true)
    expect(onTranscript).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledWith("你好世界")
    expect(onPartial).toHaveBeenCalledTimes(2)
  })
})
