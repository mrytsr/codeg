"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Mic, MicOff } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  cancelVoiceStream,
  ensureVoiceReady,
  getVoiceStatus,
  getVoiceStreamStatus,
  listenVoicePartial,
  listenVoicePrepare,
  prepareVoiceStream,
  sendVoiceStreamChunk,
  startVoiceStream,
  stopVoiceStream,
  transcribeVoice,
  type VoicePrepareProgress,
  type VoiceStatus,
} from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import {
  detectVoiceEngine,
  floatToPcm16,
  getSpeechRecognitionCtor,
  isMicrophonePermissionError,
  LocalPcmRecorder,
  localeSupportsStreaming,
  pcm16ToBase64,
  VOICE_MAX_PCM_BYTES,
  voiceLanguageForLocale,
  type SpeechRecognitionLike,
  type VoiceEngine,
} from "@/lib/voice-input"

type VoicePhase = "idle" | "listening" | "transcribing" | "preparing"

export interface ComposerVoiceButtonProps {
  disabled?: boolean
  /** The transcript lands in the editor for review — never sent automatically. */
  onTranscript: (text: string) => void
  /**
   * Live partial transcript: fired with the recognized-so-far text and the
   * owning session id — `voice://partial` events for the streaming engine,
   * interim SpeechRecognition results for the browser engine (synthetic
   * `web-*` session id). The host splices it into the composer editor in
   * place; this component renders nothing itself.
   */
  onPartial?: (text: string, sessionId: string) => void
}

/**
 * The composer's voice button. Two engines share one interaction:
 *
 *  - `web-speech` (Chrome/Edge): the browser's own SpeechRecognition — no
 *    download, no backend trip, works even in a remote desktop window.
 *  - `local`: 16 kHz PCM captured here, decoded on this machine. For zh/en
 *    locales the chunks stream into a local sherpa-onnx recognizer and the
 *    transcript arrives live (`voice://partial`); every other locale keeps
 *    the record-then-transcribe whisper.cpp path. First use of either model
 *    auto-downloads it in the app; no terminal command is ever required.
 *
 * Whichever engine produces text, it is handed to `onTranscript` so the user
 * can review it before sending (pi-voice's `pasteToEditor` contract). While a
 * session records — `voice://partial` events for the streaming engine,
 * interim SpeechRecognition results for the browser engine — each partial
 * also goes to `onPartial` so the recognized-so-far text shows up live.
 */
export function ComposerVoiceButton({
  disabled = false,
  onPartial,
  onTranscript,
}: ComposerVoiceButtonProps) {
  const t = useTranslations("Folder.chat.messageInput")
  const locale = useLocale()
  const [phase, setPhase] = useState<VoicePhase>("idle")
  // Lazy initializer keeps the probe out of an effect (no cascading render).
  // On SSR this is "none"; the client re-probes on hydration.
  const [engine, setEngine] = useState<VoiceEngine>(() => detectVoiceEngine())
  const [manualInstall, setManualInstall] = useState(false)
  const [levels, setLevels] = useState<number[]>([])

  const recorderRef = useRef<LocalPcmRecorder | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const phaseRef = useRef<VoicePhase>("idle")
  const engineRef = useRef<VoiceEngine>(engine)
  const localStatusRef = useRef<VoiceStatus | null>(null)
  const prepareUnsubRef = useRef<(() => void) | null>(null)
  const prepareToastIdRef = useRef("codeg-voice-prepare")
  const mountedRef = useRef(true)
  // Streaming session state. `chunkChain` serializes the ~100 ms uploads so
  // the recognizer hears audio in capture order; stop waits for the chain.
  const streamSessionRef = useRef<string | null>(null)
  const chunkChainRef = useRef<Promise<unknown>>(Promise.resolve())
  const streamFailuresRef = useRef(0)
  // Monotonic web-speech session counter; see `startWebSpeech`.
  const webSessionSeqRef = useRef(0)

  const setPhaseSafe = useCallback((next: VoicePhase) => {
    phaseRef.current = next
    if (mountedRef.current) setPhase(next)
  }, [])

  const progressText = useCallback(
    (progress: VoicePrepareProgress) => {
      if (progress.stage === "done") return t("voiceReady")
      if (progress.stage === "extracting") return t("voicePreparingExtracting")
      if (progress.percent >= 0) {
        return t("voicePreparingProgress", { percent: progress.percent })
      }
      return t("voicePreparing")
    },
    [t]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      recorderRef.current?.cancel()
      recognitionRef.current?.abort()
      const sessionId = streamSessionRef.current
      streamSessionRef.current = null
      if (sessionId) void cancelVoiceStream(sessionId).catch(() => {})
    }
  }, [])

  // Probe local readiness lazily. It is only a cache: if the decoder is not
  // installed yet, selecting the local engine still triggers auto-download.
  useEffect(() => {
    let active = true
    void getVoiceStatus()
      .then((status) => {
        if (!active) return
        localStatusRef.current = status
        setManualInstall(status.needsManualInstall)
      })
      .catch(() => {
        if (active) localStatusRef.current = null
      })
    return () => {
      active = false
    }
  }, [])

  // The prepare command streams `voice://prepare`; show real progress instead
  // of a frozen spinner while the decoder + model are downloaded.
  useEffect(() => {
    let active = true
    void listenVoicePrepare((progress) => {
      if (!active || progress.stage === "done") return
      toast.loading(progressText(progress), {
        id: prepareToastIdRef.current,
      })
    })
      .then((unsub) => {
        if (active) prepareUnsubRef.current = unsub
        else unsub()
      })
      .catch(() => {})
    return () => {
      active = false
      prepareUnsubRef.current?.()
      prepareUnsubRef.current = null
    }
  }, [progressText])

  // Latest partial handler, read by the mount-scoped listener below so a new
  // parent render never resubscribes (which could drop an in-flight event).
  const onPartialRef = useRef(onPartial)
  useEffect(() => {
    onPartialRef.current = onPartial
  })

  // Live partials for the streaming engine. The session filter drops events
  // from stale sessions (e.g. an aborted recording whose last chunk raced
  // the stop call); the host owns the display, through `onPartial`.
  useEffect(() => {
    let active = true
    let unsub: (() => void) | null = null
    void listenVoicePartial((event) => {
      if (!active || event.isFinal) return
      if (streamSessionRef.current !== event.sessionId) return
      onPartialRef.current?.(event.text, event.sessionId)
    })
      .then((fn) => {
        if (active) unsub = fn
        else fn()
      })
      .catch(() => {})
    return () => {
      active = false
      unsub?.()
    }
  }, [])

  // Pre-warm the streaming recognizer on mount (~1.5 s load) so the first
  // click is instant. Only when the model is already installed: never start a
  // download from a passive mount — that happens on first mic click.
  useEffect(() => {
    if (!localeSupportsStreaming(locale)) return
    let active = true
    void getVoiceStreamStatus()
      .then((status) => {
        if (!active || !status.available || status.loaded) return
        return prepareVoiceStream().catch(() => {})
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [locale])

  const ensureLocalReady = useCallback(async () => {
    const current = localStatusRef.current
    if (current?.available) return true
    if (current?.needsManualInstall) {
      toast.error(t("voiceManualInstallRequired"))
      return false
    }

    setPhaseSafe("preparing")
    toast.loading(t("voicePreparing"), { id: prepareToastIdRef.current })
    try {
      const status = await ensureVoiceReady()
      localStatusRef.current = status
      setManualInstall(status.needsManualInstall)
      if (!status.available) {
        toast.error(t("voiceManualInstallRequired"), {
          id: prepareToastIdRef.current,
        })
        return false
      }
      toast.success(t("voiceReady"), { id: prepareToastIdRef.current })
      return true
    } catch (error) {
      const appError = extractAppCommandError(error)
      toast.error(
        appError?.code === "dependency_missing"
          ? t("voiceManualInstallRequired")
          : t("voicePrepareFailed"),
        { id: prepareToastIdRef.current }
      )
      return false
    } finally {
      setPhaseSafe("idle")
    }
  }, [setPhaseSafe, t])

  const startWebSpeech = useCallback(() => {
    const ctor = getSpeechRecognitionCtor()
    if (!ctor) {
      toast.error(t("voiceUnavailable"))
      return
    }
    // Synthetic per-round session id: the host's in-place preview splice is
    // shared with the streaming engine and keys its state on it.
    const sessionId = `web-${++webSessionSeqRef.current}`
    const recognition = new ctor()
    recognition.lang = voiceLanguageForLocale(locale).speech
    recognition.continuous = false
    // Interims make the browser engine stream like the local one: every
    // revision goes to `onPartial`, the settled utterance goes through
    // `onTranscript` and swaps the preview segment for the final text.
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    let finalText = ""
    const finish = () => {
      recognitionRef.current = null
      if (phaseRef.current === "listening") setPhaseSafe("idle")
    }
    recognition.onresult = (event) => {
      let interim = ""
      let settled = false
      // Results before resultIndex were folded into finalText by earlier
      // events of this session; only scan the updates.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result?.[0]?.transcript ?? ""
        if (result.isFinal) {
          finalText += transcript
          settled = true
        } else {
          interim = transcript
        }
      }
      if (settled) {
        if (finalText.trim()) onTranscript(finalText.trim())
      } else if (interim.trim()) {
        onPartialRef.current?.(`${finalText}${interim}`.trim(), sessionId)
      }
    }
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return
      toast.error(
        isMicrophonePermissionError(event.error)
          ? t("voicePermissionDenied")
          : t("voiceFailed")
      )
    }
    recognition.onend = finish
    recognitionRef.current = recognition
    try {
      recognition.start()
      setPhaseSafe("listening")
    } catch {
      toast.error(t("voiceFailed"))
      finish()
    }
  }, [locale, onTranscript, setPhaseSafe, t])

  // Ordered upload of one ~100 ms batch. The chain (not unbounded parallel
  // calls) keeps transport backpressure without dropping audio.
  const enqueueStreamChunk = useCallback((batch: Float32Array) => {
    const sessionId = streamSessionRef.current
    if (!sessionId) return
    const base64 = pcm16ToBase64(floatToPcm16(batch))
    chunkChainRef.current = chunkChainRef.current.then(() => {
      if (streamSessionRef.current !== sessionId) return
      return sendVoiceStreamChunk(sessionId, base64).catch(() => {
        streamFailuresRef.current += 1
      })
    })
  }, [])

  const startStreaming = useCallback(async () => {
    setPhaseSafe("preparing")
    try {
      const status = await getVoiceStreamStatus()
      if (!status.loaded) {
        toast.loading(t("voicePreparing"), { id: prepareToastIdRef.current })
        await prepareVoiceStream()
        toast.success(t("voiceReady"), { id: prepareToastIdRef.current })
      }
    } catch {
      // Dependency missing is impossible here (sherpa-onnx is compiled in);
      // the realistic failures are download/load errors.
      toast.error(t("voicePrepareFailed"), {
        id: prepareToastIdRef.current,
      })
      setPhaseSafe("idle")
      return
    }

    try {
      const { sessionId } = await startVoiceStream()
      if (!mountedRef.current) {
        void cancelVoiceStream(sessionId).catch(() => {})
        return
      }
      streamSessionRef.current = sessionId
      chunkChainRef.current = Promise.resolve()
      streamFailuresRef.current = 0
      setLevels([])
      const recorder = new LocalPcmRecorder({
        onLevel: (level) => setLevels((prev) => [...prev.slice(-23), level]),
        onFrame: enqueueStreamChunk,
      })
      recorderRef.current = recorder
      await recorder.start()
      setPhaseSafe("listening")
    } catch (error) {
      const sessionId = streamSessionRef.current
      streamSessionRef.current = null
      recorderRef.current?.cancel()
      recorderRef.current = null
      if (sessionId) void cancelVoiceStream(sessionId).catch(() => {})
      toast.error(
        isMicrophonePermissionError(error)
          ? t("voicePermissionDenied")
          : t("voiceFailed")
      )
      setPhaseSafe("idle")
    }
  }, [enqueueStreamChunk, setPhaseSafe, t])

  const stopStreaming = useCallback(async () => {
    const sessionId = streamSessionRef.current
    streamSessionRef.current = null
    recorderRef.current?.cancel()
    recorderRef.current = null
    if (!sessionId) {
      setPhaseSafe("idle")
      return
    }
    setPhaseSafe("transcribing")
    try {
      await chunkChainRef.current
      const final = await stopVoiceStream(sessionId)
      if (final.text) onTranscript(final.text)
      else if (streamFailuresRef.current > 0) toast.error(t("voiceFailed"))
    } catch {
      toast.error(t("voiceFailed"))
    }
    setPhaseSafe("idle")
  }, [onTranscript, setPhaseSafe, t])

  const startLocal = useCallback(async () => {
    // zh/en locales stream (live partials); everything else records first and
    // decodes with whisper. Each path prepares its own model on first use.
    if (localeSupportsStreaming(locale)) {
      await startStreaming()
      return
    }
    // First-run install happens here, before asking for the microphone, so a
    // slow download never leaves a half-started recorder behind.
    if (!(await ensureLocalReady())) return
    setLevels([])
    const recorder = new LocalPcmRecorder({
      onLevel: (level) => setLevels((prev) => [...prev.slice(-23), level]),
    })
    recorderRef.current = recorder
    try {
      await recorder.start()
      setPhaseSafe("listening")
    } catch (error) {
      recorder.cancel()
      recorderRef.current = null
      toast.error(
        isMicrophonePermissionError(error)
          ? t("voicePermissionDenied")
          : t("voiceFailed")
      )
      setPhaseSafe("idle")
    }
  }, [ensureLocalReady, locale, setPhaseSafe, startStreaming, t])

  const stopLocal = useCallback(async () => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (!recorder) return
    setPhaseSafe("transcribing")
    try {
      const wav = await recorder.stop()
      if (!wav) {
        setPhaseSafe("idle")
        return
      }
      if (wav.byteLength > VOICE_MAX_PCM_BYTES + 44) {
        toast.error(t("voiceFailed"))
        setPhaseSafe("idle")
        return
      }
      const result = await transcribeVoice(
        wav,
        voiceLanguageForLocale(locale).whisper
      )
      if (result.text) onTranscript(result.text)
      setPhaseSafe("idle")
    } catch (error) {
      const appError = extractAppCommandError(error)
      toast.error(
        appError?.code === "dependency_missing"
          ? t("voiceManualInstallRequired")
          : t("voiceFailed")
      )
      setPhaseSafe("idle")
    }
  }, [locale, onTranscript, setPhaseSafe, t])

  const abort = useCallback(() => {
    const sessionId = streamSessionRef.current
    streamSessionRef.current = null
    if (sessionId) void cancelVoiceStream(sessionId).catch(() => {})
    recorderRef.current?.cancel()
    recorderRef.current = null
    recognitionRef.current?.abort()
    recognitionRef.current = null
    if (phaseRef.current === "listening") setPhaseSafe("idle")
  }, [setPhaseSafe])

  const toggle = useCallback(() => {
    if (
      disabled ||
      phaseRef.current === "transcribing" ||
      phaseRef.current === "preparing"
    )
      return
    if (phaseRef.current === "listening") {
      if (engineRef.current === "web-speech") {
        recognitionRef.current?.stop()
        setPhaseSafe("idle")
      } else if (streamSessionRef.current) {
        void stopStreaming()
      } else {
        void stopLocal()
      }
      return
    }
    const active = engineRef.current
    if (active === "web-speech") startWebSpeech()
    else if (active === "local") void startLocal()
    else toast.error(t("voiceUnavailable"))
  }, [
    disabled,
    setPhaseSafe,
    startLocal,
    startWebSpeech,
    stopLocal,
    stopStreaming,
    t,
  ])

  const switchToLocal = useCallback(() => {
    abort()
    engineRef.current = "local"
    setEngine("local")
    void startLocal()
  }, [abort, startLocal])

  const switchToWeb = useCallback(() => {
    abort()
    engineRef.current = "web-speech"
    setEngine("web-speech")
  }, [abort])

  const busy = phase !== "idle"
  const webSpeechAvailable = getSpeechRecognitionCtor() !== null
  const label =
    phase === "preparing"
      ? t("voicePreparing")
      : phase === "transcribing"
        ? t("voiceTranscribing")
        : phase === "listening"
          ? t("voiceStop")
          : t("voiceStart")

  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        disabled={
          disabled ||
          phase === "transcribing" ||
          phase === "preparing" ||
          engine === "none"
        }
        variant="ghost"
        size="icon-xs"
        className={
          phase === "listening"
            ? "shrink-0 text-destructive"
            : "shrink-0 text-muted-foreground"
        }
        title={label}
        aria-label={label}
        aria-pressed={phase === "listening"}
        onClick={toggle}
      >
        {phase === "listening" ? (
          <MicOff className="size-4" />
        ) : (
          <Mic className="size-4" />
        )}
      </Button>
      {phase === "listening" && levels.length > 0 && (
        <span className="flex h-4 items-end gap-px" aria-hidden="true">
          {levels.slice(-12).map((level, index) => (
            <span
              key={index}
              className="w-0.5 rounded-sm bg-current"
              style={{ height: `${Math.max(2, Math.min(16, level * 400))}px` }}
            />
          ))}
        </span>
      )}
      {!manualInstall && engine === "web-speech" && !busy && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              disabled={disabled}
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground"
              title={t("voiceEngineWeb")}
              aria-label={t("voiceSwitchEngine")}
            >
              <span className="text-[10px]">▾</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => switchToLocal()}>
              {t("voiceEngineLocal")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {engine === "local" && webSpeechAvailable && !busy && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              disabled={disabled}
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground"
              title={t("voiceEngineLocal")}
              aria-label={t("voiceSwitchEngine")}
            >
              <span className="text-[10px]">▾</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => switchToWeb()}>
              {t("voiceEngineWeb")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
