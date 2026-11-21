import { describe, expect, it, vi } from "vitest"

import {
  concatChunks,
  detectVoiceEngine,
  encodeWav16,
  floatToPcm16,
  FrameBatcher,
  frameRms,
  getSpeechRecognitionCtor,
  isMicrophonePermissionError,
  localeSupportsStreaming,
  pcm16ToBase64,
  trimSilence,
  voiceLanguageForLocale,
  VOICE_FRAME_SAMPLES,
  VOICE_SAMPLE_RATE,
  VOICE_STREAM_CHUNK_SAMPLES,
} from "./voice-input"

describe("voice-input pure helpers", () => {
  it("measures RMS from zero up to full scale", () => {
    expect(frameRms(new Float32Array(0))).toBe(0)
    expect(frameRms(new Float32Array([0, 0, 0]))).toBe(0)
    expect(frameRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1)
  })

  it("converts floats to int16 without clipping valid samples", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]))
    expect(Array.from(pcm)).toEqual([
      0, 32767, -32768, 16383, -16384, 32767, -32768,
    ])
  })

  it("concatenates chunks in order", () => {
    const joined = concatChunks([
      new Float32Array([1, 2]),
      new Float32Array([3]),
      new Float32Array([4, 5]),
    ])
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5])
  })

  it("writes a valid 44-byte WAV header for PCM16 mono", () => {
    const wav = encodeWav16(new Int16Array([0, 256, -256]))
    const view = new DataView(wav.buffer)
    const ascii = (start: number, len: number) =>
      Array.from({ length: len }, (_, i) =>
        String.fromCharCode(view.getUint8(start + i))
      ).join("")
    expect(ascii(0, 4)).toBe("RIFF")
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(ascii(36, 4)).toBe("data")
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(VOICE_SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(6) // 3 samples * 2 bytes
    expect(wav.byteLength).toBe(44 + 6)
    expect(view.getInt16(46, true)).toBe(256)
  })

  it("keeps the first 25% silence as the noise floor basis without cutting speech", () => {
    const quiet = new Float32Array(VOICE_FRAME_SAMPLES * 4)
    const speech = new Float32Array(VOICE_FRAME_SAMPLES * 3).fill(0.6)
    const tail = new Float32Array(VOICE_FRAME_SAMPLES * 2)
    const joined = concatChunks([quiet, speech, tail])
    const trimmed = trimSilence(joined)
    expect(trimmed.length).toBeGreaterThan(VOICE_FRAME_SAMPLES * 3)
    expect(trimmed.length).toBeLessThan(joined.length)
  })

  it("drops a completely silent take", () => {
    const silent = new Float32Array(VOICE_FRAME_SAMPLES * 20).fill(0.00001)
    expect(trimSilence(silent).length).toBe(0)
  })

  it("maps Chinese locales to zh for both engines, others to en", () => {
    expect(voiceLanguageForLocale("zh-CN")).toEqual({
      speech: "zh-CN",
      whisper: "zh",
    })
    expect(voiceLanguageForLocale("zh-TW")).toEqual({
      speech: "zh-CN",
      whisper: "zh",
    })
    expect(voiceLanguageForLocale("en-US")).toEqual({
      speech: "en-US",
      whisper: "en",
    })
    expect(voiceLanguageForLocale("ja-JP")).toEqual({
      speech: "en-US",
      whisper: "en",
    })
  })

  it("reports no engine in a bare Node environment", () => {
    expect(getSpeechRecognitionCtor()).toBeNull()
    expect(detectVoiceEngine()).toBe("none")
  })

  it("classifies browser microphone permission denials", () => {
    expect(isMicrophonePermissionError({ name: "NotAllowedError" })).toBe(true)
    expect(isMicrophonePermissionError({ name: "PermissionDeniedError" })).toBe(
      true
    )
    expect(isMicrophonePermissionError({ code: "permission_denied" })).toBe(
      true
    )
    expect(isMicrophonePermissionError({ name: "NotFoundError" })).toBe(false)
    expect(isMicrophonePermissionError(new Error("codec init failed"))).toBe(
      false
    )
  })

  it.each([
    {
      label: "macOS desktop",
      platform: "MacIntel",
      tauri: true,
      engine: "local",
    },
    {
      label: "Windows desktop",
      platform: "Win32",
      tauri: true,
      engine: "web-speech",
    },
    {
      label: "browser on macOS",
      platform: "MacIntel",
      tauri: false,
      engine: "web-speech",
    },
  ])("selects $engine in $label", ({ platform, tauri, engine }) => {
    vi.stubGlobal("window", {
      ...(tauri ? { __TAURI_INTERNALS__: {} } : {}),
      webkitSpeechRecognition: class {},
      AudioContext: class {},
    })
    vi.stubGlobal("navigator", {
      platform,
      userAgent: "",
      mediaDevices: { getUserMedia: vi.fn() },
    })
    try {
      expect(detectVoiceEngine()).toBe(engine)
      if (engine === "local") expect(getSpeechRecognitionCtor()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("routes only zh and en locales to the streaming engine", () => {
    expect(localeSupportsStreaming("zh-CN")).toBe(true)
    expect(localeSupportsStreaming("zh-TW")).toBe(true)
    expect(localeSupportsStreaming("en-US")).toBe(true)
    expect(localeSupportsStreaming("ja-JP")).toBe(false)
    expect(localeSupportsStreaming("ko")).toBe(false)
    expect(localeSupportsStreaming("de-DE")).toBe(false)
  })

  it("encodes PCM16 as base64 in byte order", () => {
    // Little-endian: sample 1 is the byte pair [0x01, 0x00].
    expect(pcm16ToBase64(new Int16Array([1]))).toBe(btoa("\x01\x00"))
    // Multi-chunk path: >8192 bytes still round-trips.
    const big = new Int16Array(6000)
    for (let i = 0; i < big.length; i++) big[i] = i % 256
    const decoded = atob(pcm16ToBase64(big))
    expect(decoded.length).toBe(big.length * 2)
    expect(decoded.charCodeAt(0)).toBe(0)
    expect(decoded.charCodeAt(1)).toBe(0)
    expect(decoded.charCodeAt(2)).toBe(1)
    expect(decoded.charCodeAt(3)).toBe(0)
  })

  it("accumulates worklet frames into ~100 ms batches", () => {
    const batcher = new FrameBatcher(VOICE_STREAM_CHUNK_SAMPLES)
    // 512-sample worklet frames: three are below capacity, the fourth
    // overshoots and flushes frame-aligned (4 × 512 = 2048).
    expect(batcher.push(new Float32Array(VOICE_FRAME_SAMPLES).fill(1))).toBe(
      null
    )
    expect(batcher.push(new Float32Array(VOICE_FRAME_SAMPLES).fill(2))).toBe(
      null
    )
    expect(batcher.push(new Float32Array(VOICE_FRAME_SAMPLES).fill(3))).toBe(
      null
    )
    const batch = batcher.push(new Float32Array(VOICE_FRAME_SAMPLES).fill(4))
    expect(batch?.length).toBe(VOICE_FRAME_SAMPLES * 4)
    expect(batch?.[0]).toBe(1)
    expect(batch?.[VOICE_FRAME_SAMPLES * 2]).toBe(3)
    expect(batch?.[VOICE_STREAM_CHUNK_SAMPLES - 1]).toBe(4)
    // The accumulator resets after a flush.
    expect(batcher.push(new Float32Array(VOICE_FRAME_SAMPLES))).toBe(null)
  })

  it("flushes immediately for oversized frames (ScriptProcessor path)", () => {
    const batcher = new FrameBatcher(VOICE_STREAM_CHUNK_SAMPLES)
    const big = new Float32Array(4096)
    const batch = batcher.push(big)
    expect(batch?.length).toBe(4096)
  })

  it("ignores empty frames without corrupting the batch", () => {
    const batcher = new FrameBatcher(4)
    expect(batcher.push(new Float32Array(0))).toBe(null)
    const batch = batcher.push(new Float32Array(4))
    expect(batch?.length).toBe(4)
  })
})
