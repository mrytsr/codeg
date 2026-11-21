/**
 * Composer voice input: engine detection, 16 kHz PCM capture, silence
 * trimming and WAV framing.
 *
 * Two engines share one UI:
 *  - `web-speech`: the browser's own SpeechRecognition (Chrome / Edge). No
 *    audio ever leaves the page through our code — the browser handles it.
 *  - `local`: capture raw PCM here, hand a 16 kHz mono WAV to the backend's
 *    whisper.cpp sidecar. Used where SpeechRecognition is unavailable (e.g.
 *    WebView2) or when the caller asks for offline transcription.
 *
 * The pure helpers below (VAD, PCM conversion, WAV framing) are deliberately
 * free of browser globals so they can be unit-tested in Node.
 */

import { detectPlatform } from "@/hooks/use-platform"

import { detectEnvironment } from "./transport/detect"

export type VoiceEngine = "web-speech" | "local" | "none"

export const VOICE_SAMPLE_RATE = 16_000
/** 32 ms at 16 kHz — the frame size Handy / pi-voice use for Silero. */
export const VOICE_FRAME_SAMPLES = 512
/** 8 MiB of WAV payload is far beyond a normal composer utterance. */
export const VOICE_MAX_PCM_BYTES = 8 * 1024 * 1024
/** ~100 ms of audio: the cadence streaming chunks are shipped to the backend. */
export const VOICE_STREAM_CHUNK_SAMPLES = VOICE_SAMPLE_RATE / 10

// ─── Web Speech API (not in TS's DOM lib yet) ─────────────────────────

interface SpeechResultLike {
  readonly length: number
  readonly isFinal: boolean
  0: { readonly transcript: string }
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number
  readonly results: {
    readonly length: number
    [index: number]: SpeechResultLike
  }
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string; message?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionCtor
  webkitSpeechRecognition?: SpeechRecognitionCtor
}

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null
  // WKWebView can expose SpeechRecognition without a usable speech service.
  // The macOS desktop app uses microphone capture and the backend recognizer.
  if (detectEnvironment() === "tauri" && detectPlatform() === "macos") {
    return null
  }
  const w = window as SpeechWindow
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function isMicrophonePermissionError(error: unknown): boolean {
  const permissionMessage = /permission|denied|权限/i
  if (typeof error === "string") {
    return error === "not-allowed" || permissionMessage.test(error)
  }
  if (typeof error !== "object" || error === null) return false

  const { name, code, message } = error as {
    name?: unknown
    code?: unknown
    message?: unknown
  }
  return (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    code === "permission_denied" ||
    (typeof message === "string" && permissionMessage.test(message))
  )
}

export function canCaptureLocalAudio(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    typeof window.AudioContext === "function"
  )
}

/** Prefer available Web Speech, then local audio capture. */
export function detectVoiceEngine(): VoiceEngine {
  if (getSpeechRecognitionCtor()) return "web-speech"
  if (canCaptureLocalAudio()) return "local"
  return "none"
}

/** Whisper and Web Speech use different tags for the same UI locale. */
export function voiceLanguageForLocale(locale: string): {
  speech: string
  whisper: string
} {
  const speech = locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
  return { speech, whisper: speech === "zh-CN" ? "zh" : "en" }
}

/**
 * The bundled streaming model is a bilingual zh+en zipformer; those locales
 * get live partials, everything else keeps the record-then-transcribe
 * whisper path (see `voice_stream.rs` for the model split).
 */
export function localeSupportsStreaming(locale: string): boolean {
  const lower = locale.toLowerCase()
  return lower.startsWith("zh") || lower.startsWith("en")
}

// ─── Pure DSP helpers ─────────────────────────────────────────────────

/** RMS amplitude in [0, 1]; used for both VAD and the level meter. */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/**
 * Base64-encode PCM16 samples for the `voice_stream_chunk` wire format.
 * String.fromCharCode is applied in ≤8 KB slices — larger spread-apply calls
 * overflow the argument limit on some engines.
 */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    const slice = bytes.subarray(offset, Math.min(offset + 8192, bytes.length))
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary)
}

/**
 * Trim silence around speech with a trailing hangover so a short pause in
 * the middle of a sentence does not cut the utterance. The noise floor is
 * the quietest 25% of frames; the gate sits 6 dB above it with a fixed
 * minimum so a fully silent room never trips on encoder hiss.
 */
export function trimSilence(
  samples: Float32Array,
  frameSize = VOICE_FRAME_SAMPLES,
  hangoverFrames = 15
): Float32Array {
  const frames: Float32Array[] = []
  for (let start = 0; start < samples.length; start += frameSize) {
    frames.push(
      samples.subarray(start, Math.min(start + frameSize, samples.length))
    )
  }
  if (frames.length === 0) return new Float32Array(0)

  const levels = frames.map(frameRms).sort((a, b) => a - b)
  const noiseFloor = levels[Math.floor(levels.length * 0.25)] ?? 0
  const threshold = Math.max(0.008, noiseFloor * 2)

  let first = -1
  let last = -1
  for (let i = 0; i < frames.length; i++) {
    if (frameRms(frames[i]) > threshold) {
      if (first < 0) first = i
      last = i + hangoverFrames
    }
  }
  if (first < 0) return new Float32Array(0)

  const start = first * frameSize
  const end = Math.min(samples.length, (last + 1) * frameSize)
  return samples.slice(start, end)
}

/** Concatenate captured chunks into one contiguous Float32 buffer. */
export function concatChunks(chunks: Float32Array[]): Float32Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Float32Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Accumulates worklet frames into fixed-size sample batches. The recorder
 * keeps one per session so the level meter and the streaming chunk upload
 * fire off the same ~100 ms batches and never drift apart.
 */
export class FrameBatcher {
  private buffer: Float32Array[] = []
  private total = 0

  constructor(private readonly capacity: number) {}

  /** Returns the batch once `capacity` samples have accumulated. */
  push(frame: Float32Array): Float32Array | null {
    if (frame.length === 0) return null
    this.buffer.push(frame)
    this.total += frame.length
    if (this.total < this.capacity) return null
    const batch = concatChunks(this.buffer)
    this.buffer = []
    this.total = 0
    return batch
  }
}

/** Wrap PCM16 mono samples in a canonical 44-byte WAV header. */
export function encodeWav16(
  pcm: Int16Array,
  sampleRate = VOICE_SAMPLE_RATE
): Uint8Array {
  const dataBytes = pcm.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true) // PCM chunk length
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, "data")
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < pcm.length; i++, offset += 2)
    view.setInt16(offset, pcm[i], true)
  return out
}

// ─── Local PCM recorder ───────────────────────────────────────────────

const WORKLET_SOURCE = `
class VoicePcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0 && input[0]) {
      this.port.postMessage(new Float32Array(input[0]))
    }
    return true
  }
}
registerProcessor("voice-pcm", VoicePcmProcessor)
`

export interface LocalRecorderOptions {
  /** Called with an RMS level every ~100 ms for the waveform. */
  onLevel?: (level: number) => void
  /**
   * Called with the same ~100 ms batches the level meter sees (streaming
   * mode uploads each batch as 16 kHz mono PCM16 to `voice_stream_chunk`).
   */
  onFrame?: (samples: Float32Array) => void
}

/**
 * Records 16 kHz mono Float32 via an inline AudioWorklet. The worklet source
 * is a Blob URL so no extra asset is needed in the static export. Browsers
 * without AudioWorklet fall back to ScriptProcessorNode.
 */
export class LocalPcmRecorder {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: AudioNode | null = null
  private node: AudioWorkletNode | ScriptProcessorNode | null = null
  private workletUrl: string | null = null
  private chunks: Float32Array[] = []
  private batcher = new FrameBatcher(VOICE_STREAM_CHUNK_SAMPLES)
  private stopped = false

  constructor(private readonly options: LocalRecorderOptions = {}) {}

  get isRecording(): boolean {
    return this.context !== null && !this.stopped
  }

  async start(): Promise<void> {
    if (this.context) throw new Error("voice recorder already started")
    this.stopped = false
    this.chunks = []
    this.batcher = new FrameBatcher(VOICE_STREAM_CHUNK_SAMPLES)

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.stream = stream
    const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
    this.context = context
    const source = context.createMediaStreamSource(stream)
    this.source = source

    const onFrame = (frame: Float32Array) => {
      if (this.stopped) return
      this.chunks.push(frame)
      const batch = this.batcher.push(frame)
      if (!batch) return
      this.options.onLevel?.(frameRms(batch))
      this.options.onFrame?.(batch)
    }

    if (context.audioWorklet) {
      const blob = new Blob([WORKLET_SOURCE], {
        type: "application/javascript",
      })
      const url = URL.createObjectURL(blob)
      this.workletUrl = url
      await context.audioWorklet.addModule(url)
      const node = new AudioWorkletNode(context, "voice-pcm", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      })
      node.port.onmessage = (event: MessageEvent<Float32Array>) =>
        onFrame(event.data)
      source.connect(node)
      this.node = node
    } else {
      const node = context.createScriptProcessor(4096, 1, 1)
      node.onaudioprocess = (event) => {
        onFrame(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(node)
      // ScriptProcessor only fires when connected to a destination. A zero
      // gain keeps the microphone out of the speakers.
      const sink = context.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(context.destination)
      this.node = node
    }
  }

  /** Stop capture and return a 16 kHz mono WAV, or null when nothing was said. */
  async stop(): Promise<Uint8Array | null> {
    if (!this.context || this.stopped) return null
    this.stopped = true
    const raw = concatChunks(this.chunks)
    this.chunks = []
    this.cleanup()
    if (raw.length === 0) return null
    const voiced = trimSilence(raw)
    if (voiced.length === 0) return null
    return encodeWav16(floatToPcm16(voiced))
  }

  cancel(): void {
    this.stopped = true
    this.chunks = []
    this.batcher = new FrameBatcher(VOICE_STREAM_CHUNK_SAMPLES)
    this.cleanup()
  }

  private cleanup(): void {
    try {
      this.node?.disconnect()
    } catch {
      // already detached
    }
    try {
      this.source?.disconnect()
    } catch {
      // already detached
    }
    this.stream?.getTracks().forEach((track) => track.stop())
    if (this.context && this.context.state !== "closed")
      void this.context.close()
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl)
    this.node = null
    this.source = null
    this.stream = null
    this.context = null
    this.workletUrl = null
  }
}
