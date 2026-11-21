//! Streaming local speech-to-text for the composer's voice button.
//!
//! Where [`crate::commands::voice`] records first and decodes a whole WAV
//! afterwards, this module feeds 16 kHz mono PCM chunks from the renderer
//! straight into a sherpa-onnx `OnlineRecognizer` and emits partial
//! transcripts as they arrive (`voice://partial`). The bundled model is the
//! 14 M bilingual streaming zipformer — Chinese + English only; every other
//! locale keeps the whisper batch path, and whisper stays the fallback for
//! long audio in both runtimes. No audio leaves the machine: the only network
//! use is the one-time model download in [`voice_stream_prepare_core`].
//!
//! Both the Tauri commands and the web handlers call the same `_core`
//! functions. State is process-global because neither mode owns a long-lived
//! voice service:
//!   - one `OnlineRecognizer`, loaded once into a [`OnceLock`] (the ~1.5 s
//!     model load is why the composer pre-warms on mount);
//!   - one session map keyed by UUID. Every decode happens under that map's
//!     mutex, so concurrent sessions can never decode against the shared
//!     recognizer at the same time.
//!
//! Model resolution order: `CODEG_STREAM_MODEL_DIR` environment override, then
//! `CODEG_DATA_DIR/voice/streaming/<model>` (the documented install location).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use crate::app_error::AppCommandError;
use crate::commands::voice::{
    clean_transcript, download_file, emit_progress, voice_data_dir, VoicePrepareStage,
};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Progress topic shared with the frontend (`listenVoicePrepare`). The
/// streaming download reuses the whisper prepare channel so the composer
/// shows one consistent progress toast.
pub const VOICE_STREAM_PREPARE_EVENT: &str = "voice://prepare";
/// Live partial transcripts while the user speaks (`listenVoicePartial`).
pub const VOICE_PARTIAL_EVENT: &str = "voice://partial";

/// The 14 M streaming zipformer is bilingual zh+en; int8 keeps it at ~24 MB
/// on disk and RTF ≈ 0.03 on CPU (measured in `tools/voice-stream-poc`).
const STREAM_MODEL_DIR_NAME: &str = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
const STREAM_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2";
/// The renderer captures mono PCM at 16 kHz (see `src/lib/voice-input.ts`).
const VOICE_SAMPLE_RATE: i32 = 16_000;
/// 100 ms of 16 kHz PCM16 is ~3.2 KB; 1 MiB of decoded chunk is ~30 s of
/// audio, far past anything the composer cadence produces.
const CHUNK_MAX_BYTES: usize = 1024 * 1024;
/// A session the composer abandoned without stop/cancel is swept the next
/// time a session starts.
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Preferred file names inside the model directory, best first. The release
/// archive ships fp32 and int8 variants; int8 is what we ship to users.
const ENCODER_NAMES: [&str; 4] = [
    "encoder-epoch-99-avg-1.int8.onnx",
    "encoder-epoch-99-avg-1.onnx",
    "encoder.int8.onnx",
    "encoder.onnx",
];
const DECODER_NAMES: [&str; 3] = [
    "decoder-epoch-99-avg-1.int8.onnx",
    "decoder-epoch-99-avg-1.onnx",
    "decoder.onnx",
];
const JOINER_NAMES: [&str; 3] = [
    "joiner-epoch-99-avg-1.int8.onnx",
    "joiner-epoch-99-avg-1.onnx",
    "joiner.onnx",
];
const TOKENS_NAMES: [&str; 1] = ["tokens.txt"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamStatus {
    /// True when the model files are installed (the recognizer may still need
    /// a one-time ~1.5 s load).
    pub available: bool,
    /// True when the recognizer is already loaded and `start` is instant.
    pub loaded: bool,
    pub model_dir: Option<String>,
    /// Human-readable reason when `available` is false.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamStartResult {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamChunkResult {
    /// Transcript so far, identical to what was emitted on `voice://partial`.
    pub partial: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamFinal {
    pub session_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamCancelResult {
    /// False when the session was already gone (double cancel is not an error).
    pub cancelled: bool,
}

/// Wire format of a `voice://partial` event. (`final` is a reserved keyword,
/// so the field is `is_final` on the wire too.)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePartialEvent {
    pub session_id: String,
    pub text: String,
    pub is_final: bool,
}

// ─── Model resolution ──────────────────────────────────────────────────

struct StreamModelFiles {
    encoder: PathBuf,
    decoder: PathBuf,
    joiner: PathBuf,
    tokens: PathBuf,
}

/// Directory the streaming model is looked up in: the env override wins, then
/// the documented install location.
fn streaming_model_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CODEG_STREAM_MODEL_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(dir);
    }
    voice_data_dir()
        .join("streaming")
        .join(STREAM_MODEL_DIR_NAME)
}

/// First existing file among `names` in `dir`.
fn first_file(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn resolve_stream_model_files() -> Option<StreamModelFiles> {
    let dir = streaming_model_dir();
    Some(StreamModelFiles {
        encoder: first_file(&dir, &ENCODER_NAMES)?,
        decoder: first_file(&dir, &DECODER_NAMES)?,
        joiner: first_file(&dir, &JOINER_NAMES)?,
        tokens: first_file(&dir, &TOKENS_NAMES)?,
    })
}

pub fn voice_stream_status_core() -> VoiceStreamStatus {
    let dir = streaming_model_dir();
    let files = resolve_stream_model_files();
    let reason = if files.is_none() {
        Some(format!(
            "streaming model not installed yet (looked in {})",
            dir.display()
        ))
    } else {
        None
    };
    VoiceStreamStatus {
        available: files.is_some(),
        loaded: RECOGNIZER.get().is_some(),
        model_dir: files.as_ref().map(|f| {
            f.encoder
                .parent()
                .unwrap_or(Path::new(""))
                .to_string_lossy()
                .into_owned()
        }),
        reason,
    }
}

// ─── Recognizer lifecycle ──────────────────────────────────────────────

/// The shared recognizer. `OnlineRecognizer` is `Send + Sync` (unsafe impls in
/// the crate), and decode calls are serialized by the session map mutex below,
/// so the raw-pointer wrapper is never touched concurrently.
static RECOGNIZER: OnceLock<Arc<OnlineRecognizer>> = OnceLock::new();

struct StreamSession {
    stream: OnlineStream,
    last_partial: String,
    last_seen: Instant,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, StreamSession>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, StreamSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serialize concurrent prepare calls (two composers, two windows) so only one
/// download + load runs; the second caller sees the finished install.
static STREAM_PREPARE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn build_recognizer(files: &StreamModelFiles) -> Option<OnlineRecognizer> {
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let mut config = OnlineRecognizerConfig::default();
    config.model_config.transducer.encoder = Some(path(&files.encoder));
    config.model_config.transducer.decoder = Some(path(&files.decoder));
    config.model_config.transducer.joiner = Some(path(&files.joiner));
    config.model_config.tokens = Some(path(&files.tokens));
    config.model_config.num_threads = 2;
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.debug = false;
    // The composer session ends when the user clicks stop; endpoint resets
    // would clear mid-utterance text we have no way to re-attach.
    config.enable_endpoint = false;
    config.decoding_method = Some("greedy_search".to_string());
    OnlineRecognizer::create(&config)
}

/// Download + extract the streaming model on first use.
async fn download_stream_model(emitter: &EventEmitter) -> Result<(), AppCommandError> {
    let dir = voice_data_dir().join("streaming");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppCommandError::io_error(format!("create streaming dir: {e}")))?;
    let final_dir = dir.join(STREAM_MODEL_DIR_NAME);

    let tmp = dir.join(format!(".dl-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp)
        .map_err(|e| AppCommandError::io_error(format!("create temp: {e}")))?;
    let archive = tmp.join("model.tar.bz2");
    let download = download_file(STREAM_MODEL_URL, &archive, |pct| {
        emit_progress(
            emitter,
            VoicePrepareStage::DownloadingStreamModel,
            pct,
            &format!("Downloading streaming model... {pct}%"),
        )
    })
    .await;
    if download.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    download?;

    emit_progress(
        emitter,
        VoicePrepareStage::Extracting,
        -1,
        "Extracting streaming model...",
    );
    let extract = || -> Result<Vec<PathBuf>, AppCommandError> {
        let extract_dir = tmp.join("extract");
        std::fs::create_dir_all(&extract_dir)
            .map_err(|e| AppCommandError::io_error(format!("create extract dir: {e}")))?;
        let file = std::fs::File::open(&archive)
            .map_err(|e| AppCommandError::io_error(format!("open tar.bz2: {e}")))?;
        let bz = bzip2::read::BzDecoder::new(file);
        let mut tar = tar::Archive::new(bz);
        tar.unpack(&extract_dir)
            .map_err(|e| AppCommandError::io_error(format!("extract tar.bz2: {e}")))?;

        // The archive wraps everything in `<model>/`; find the four files
        // wherever they landed and install them flat.
        let wanted: [(&[&str], &str); 4] = [
            (&ENCODER_NAMES, "encoder"),
            (&DECODER_NAMES, "decoder"),
            (&JOINER_NAMES, "joiner"),
            (&TOKENS_NAMES, "tokens"),
        ];
        let mut found = Vec::new();
        for (names, label) in wanted {
            let file = names
                .iter()
                .find_map(|name| find_file(&extract_dir, name))
                .ok_or_else(|| {
                    AppCommandError::dependency_missing(format!(
                        "archive did not contain {label} for the streaming model"
                    ))
                })?;
            found.push(file);
        }
        Ok(found)
    }();
    if extract.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    let found = extract?;

    std::fs::create_dir_all(&final_dir)
        .map_err(|e| AppCommandError::io_error(format!("create model dir: {e}")))?;
    for file in found {
        let dest = final_dir.join(file.file_name().expect("file names have no parent"));
        std::fs::copy(&file, &dest)
            .map_err(|e| AppCommandError::io_error(format!("install model file: {e}")))?;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}

/// Find `name` anywhere under `root` (the archive nests one folder deep).
fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_name().to_string_lossy() == name {
                    return Some(path);
                }
                if path.is_dir() {
                    stack.push(path);
                }
            }
        }
    }
    None
}

/// Ensure the recognizer is loaded: install the model if needed, then load it
/// (off the async executor — the load blocks for ~1.5 s). Emits the same
/// `voice://prepare` progress the whisper download does.
async fn ensure_recognizer_loaded(
    emitter: &EventEmitter,
) -> Result<Arc<OnlineRecognizer>, AppCommandError> {
    if let Some(recognizer) = RECOGNIZER.get() {
        return Ok(recognizer.clone());
    }
    let _guard = STREAM_PREPARE_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    if let Some(recognizer) = RECOGNIZER.get() {
        return Ok(recognizer.clone());
    }

    if resolve_stream_model_files().is_none() {
        download_stream_model(emitter).await?;
    }
    let files = resolve_stream_model_files().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "streaming model files missing after install; set CODEG_STREAM_MODEL_DIR to override",
        )
    })?;

    emit_progress(
        emitter,
        VoicePrepareStage::LoadingModel,
        -1,
        "Loading model...",
    );
    let files = StreamModelFiles {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
        tokens: files.tokens,
    };
    let recognizer = tokio::task::spawn_blocking(move || build_recognizer(&files))
        .await
        .map_err(|e| AppCommandError::io_error(format!("model load join: {e}")))?
        .ok_or_else(|| {
            AppCommandError::dependency_missing("failed to create the streaming recognizer")
        })?;
    emit_progress(emitter, VoicePrepareStage::Done, 100, "Ready");

    let recognizer = Arc::new(recognizer);
    let _ = RECOGNIZER.set(recognizer.clone());
    Ok(recognizer)
}

/// Download (first use) + load the streaming model. Idempotent and fast once
/// loaded, so the composer calls it on mount to pre-warm.
pub async fn voice_stream_prepare_core(
    emitter: &EventEmitter,
) -> Result<VoiceStreamStatus, AppCommandError> {
    ensure_recognizer_loaded(emitter).await?;
    Ok(voice_stream_status_core())
}

// ─── Session lifecycle ─────────────────────────────────────────────────

/// Drop sessions the composer abandoned without stop/cancel.
fn prune_idle_sessions(map: &mut HashMap<String, StreamSession>) {
    let cutoff = Instant::now() - SESSION_IDLE_TIMEOUT;
    map.retain(|_, session| session.last_seen >= cutoff);
}

pub async fn voice_stream_start_core(
    _emitter: &EventEmitter,
) -> Result<VoiceStreamStartResult, AppCommandError> {
    let recognizer = RECOGNIZER.get().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "streaming model not prepared yet; call voice_stream_prepare first",
        )
    })?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let stream = recognizer.create_stream();
    let mut map = sessions()
        .lock()
        .map_err(|_| AppCommandError::io_error("voice stream sessions poisoned"))?;
    prune_idle_sessions(&mut map);
    map.insert(
        session_id.clone(),
        StreamSession {
            stream,
            last_partial: String::new(),
            last_seen: Instant::now(),
        },
    );
    Ok(VoiceStreamStartResult { session_id })
}

/// Decode base64 PCM16 mono into f32 samples in [-1, 1].
fn pcm16_base64_to_samples(payload: &str) -> Result<Vec<f32>, AppCommandError> {
    let bytes = BASE64
        .decode(payload)
        .map_err(|e| AppCommandError::invalid_input(format!("invalid voice stream chunk: {e}")))?;
    if bytes.is_empty() {
        return Err(AppCommandError::invalid_input("empty voice stream chunk"));
    }
    if bytes.len() > CHUNK_MAX_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "voice stream chunk too large: {} bytes (limit {CHUNK_MAX_BYTES})",
            bytes.len()
        )));
    }
    if bytes.len() % 2 != 0 {
        return Err(AppCommandError::invalid_input(
            "voice stream chunk must be PCM16 (even byte count)",
        ));
    }
    let (pairs, rest) = bytes.as_chunks::<2>();
    debug_assert!(
        rest.is_empty(),
        "even byte count checked above, so no remainder"
    );
    Ok(pairs
        .iter()
        .map(|b| i16::from_le_bytes(*b) as f32 / 32768.0)
        .collect())
}

/// Feed one PCM chunk and decode whatever is ready. Returns the transcript so
/// far; the same text is broadcast on `voice://partial` whenever it changed.
pub async fn voice_stream_chunk_core(
    emitter: &EventEmitter,
    session_id: &str,
    pcm16_base64: &str,
) -> Result<VoiceStreamChunkResult, AppCommandError> {
    let samples = pcm16_base64_to_samples(pcm16_base64)?;
    let recognizer = RECOGNIZER.get().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "streaming model not prepared yet; call voice_stream_prepare first",
        )
    })?;

    let mut map = sessions()
        .lock()
        .map_err(|_| AppCommandError::io_error("voice stream sessions poisoned"))?;
    let session = map
        .get_mut(session_id)
        .ok_or_else(|| AppCommandError::invalid_input("unknown voice stream session"))?;
    session.last_seen = Instant::now();
    session.stream.accept_waveform(VOICE_SAMPLE_RATE, &samples);
    while recognizer.is_ready(&session.stream) {
        recognizer.decode(&session.stream);
    }
    let text = recognizer
        .get_result(&session.stream)
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default();
    if !text.is_empty() && text != session.last_partial {
        session.last_partial = text.clone();
        emit_event(
            emitter,
            VOICE_PARTIAL_EVENT,
            VoicePartialEvent {
                session_id: session_id.to_string(),
                text: text.clone(),
                is_final: false,
            },
        );
    }
    Ok(VoiceStreamChunkResult { partial: text })
}

/// Flush the stream, return the final transcript and drop the session.
pub async fn voice_stream_stop_core(
    emitter: &EventEmitter,
    session_id: &str,
) -> Result<VoiceStreamFinal, AppCommandError> {
    let recognizer = RECOGNIZER.get().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "streaming model not prepared yet; call voice_stream_prepare first",
        )
    })?;

    let mut map = sessions()
        .lock()
        .map_err(|_| AppCommandError::io_error("voice stream sessions poisoned"))?;
    let session = map
        .remove(session_id)
        .ok_or_else(|| AppCommandError::invalid_input("unknown voice stream session"))?;

    session.stream.input_finished();
    while recognizer.is_ready(&session.stream) {
        recognizer.decode(&session.stream);
    }
    let text = clean_transcript(
        &recognizer
            .get_result(&session.stream)
            .map(|r| r.text)
            .unwrap_or_default(),
    );
    drop(map);
    emit_event(
        emitter,
        VOICE_PARTIAL_EVENT,
        VoicePartialEvent {
            session_id: session_id.to_string(),
            text: text.clone(),
            is_final: true,
        },
    );
    Ok(VoiceStreamFinal {
        session_id: session_id.to_string(),
        text,
    })
}

/// Discard a session without decoding. Safe to call twice.
pub fn voice_stream_cancel_core(session_id: &str) -> VoiceStreamCancelResult {
    let cancelled = match sessions().lock() {
        Ok(mut map) => map.remove(session_id).is_some(),
        Err(_) => false,
    };
    VoiceStreamCancelResult { cancelled }
}

// ─── Tauri commands (desktop only) ─────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn voice_stream_prepare(
    app: tauri::AppHandle,
) -> Result<VoiceStreamStatus, AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    voice_stream_prepare_core(&emitter).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn voice_stream_start(
    app: tauri::AppHandle,
) -> Result<VoiceStreamStartResult, AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    voice_stream_start_core(&emitter).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn voice_stream_chunk(
    app: tauri::AppHandle,
    session_id: String,
    pcm16_base64: String,
) -> Result<VoiceStreamChunkResult, AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    voice_stream_chunk_core(&emitter, &session_id, &pcm16_base64).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn voice_stream_stop(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<VoiceStreamFinal, AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    voice_stream_stop_core(&emitter, &session_id).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn voice_stream_status() -> VoiceStreamStatus {
    voice_stream_status_core()
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn voice_stream_cancel(session_id: String) -> VoiceStreamCancelResult {
    voice_stream_cancel_core(&session_id)
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sherpa_onnx::Wave;

    #[test]
    fn decodes_pcm16_base64_into_unit_range_samples() {
        let pcm: Vec<u8> = [0i16, 16384, -16384, 32767]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let samples = pcm16_base64_to_samples(&BASE64.encode(&pcm)).unwrap();
        assert_eq!(samples.len(), 4);
        assert_eq!(samples[0], 0.0);
        assert!((samples[1] - 0.5).abs() < 1e-6);
        assert!((samples[2] + 0.5).abs() < 1e-6);
        // Full scale is 32767/32768, not exactly 1.0.
        assert!((samples[3] - 32767.0 / 32768.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_bad_chunks() {
        assert!(pcm16_base64_to_samples("not base64!!").is_err());
        assert!(pcm16_base64_to_samples(&BASE64.encode([])).is_err());
        // Odd byte count: not a complete PCM16 frame.
        assert!(pcm16_base64_to_samples(&BASE64.encode([1u8, 2, 3])).is_err());
        let oversized = vec![0u8; CHUNK_MAX_BYTES + 2];
        assert!(pcm16_base64_to_samples(&BASE64.encode(&oversized)).is_err());
    }

    #[test]
    fn first_file_prefers_int8_variants() {
        let dir = tempfile::tempdir().unwrap();
        // Only the fp32 names exist: they are picked.
        std::fs::write(dir.path().join("encoder-epoch-99-avg-1.onnx"), b"x").unwrap();
        let found = first_file(dir.path(), &ENCODER_NAMES).unwrap();
        assert_eq!(
            found.file_name().unwrap().to_string_lossy(),
            "encoder-epoch-99-avg-1.onnx"
        );

        // Both exist: the int8 variant wins.
        std::fs::write(dir.path().join("encoder-epoch-99-avg-1.int8.onnx"), b"x").unwrap();
        let found = first_file(dir.path(), &ENCODER_NAMES).unwrap();
        assert_eq!(
            found.file_name().unwrap().to_string_lossy(),
            "encoder-epoch-99-avg-1.int8.onnx"
        );

        // Nothing matches: None.
        let missing = first_file(dir.path(), &DECODER_NAMES);
        assert!(missing.is_none());
    }

    #[test]
    fn status_is_unavailable_without_a_model() {
        // No env override and no install directory in the test environment:
        // the status must report unavailable with a reason that names the
        // expected location.
        let status = voice_stream_status_core();
        if status.available {
            // A developer machine with the model installed is fine too; just
            // check the invariant then.
            assert!(status.reason.is_none());
        } else {
            assert!(status.reason.unwrap().contains("streaming model"));
        }
        // `loaded` is not asserted here: the end-to-end decode test below
        // loads the recognizer into the process-global slot when the model
        // is installed, and test execution order is not deterministic.
    }

    /// Real end-to-end decode: feed the PoC model's official test WAV through
    /// prepare → start → ~100 ms chunks → stop and assert the transcript.
    /// Skips (passes with a note) wherever the model is not installed, so CI
    /// machines without the 75 MB download stay green. On a developer machine
    /// with `tools/voice-stream-poc/models/` populated this exercises the
    /// exact production decode path.
    ///
    /// Sync test on its own current-thread runtime: the env override must be
    /// scoped by `temp_env::with_var` (which serializes env mutation across
    /// tests), and that closure cannot await.
    #[test]
    fn streams_a_real_wav_through_start_chunk_stop_when_model_installed() {
        // Candidate install locations, best first: the PoC's downloaded model
        // next to this crate, then the documented install dir.
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let poc_model = manifest
            .parent()
            .unwrap()
            .join("tools/voice-stream-poc/models")
            .join(STREAM_MODEL_DIR_NAME);
        let wav = poc_model.join("test_wavs").join("0.wav");
        let candidates = [poc_model, streaming_model_dir()];
        let Some(model_dir) = candidates
            .into_iter()
            .find(|dir| dir.is_dir() && first_file(dir, &ENCODER_NAMES).is_some())
        else {
            eprintln!("skipping: no installed streaming model found");
            return;
        };

        temp_env::with_var("CODEG_STREAM_MODEL_DIR", Some(&model_dir), || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("test runtime");
            rt.block_on(async {
                // The global recognizer persists for the process; preparing
                // twice is a no-op, so this stays correct in any test order.
                voice_stream_prepare_core(&EventEmitter::Noop)
                    .await
                    .expect("prepare loads the installed model");

                let start = voice_stream_start_core(&EventEmitter::Noop)
                    .await
                    .expect("start creates a session");
                let wave = Wave::read(&wav.to_string_lossy()).expect("read test WAV");
                assert_eq!(wave.sample_rate(), VOICE_SAMPLE_RATE, "16 kHz test WAV");

                let mut partials: Vec<String> = Vec::new();
                for chunk in wave.samples().chunks(VOICE_SAMPLE_RATE as usize / 10) {
                    let result = voice_stream_chunk_core(
                        &EventEmitter::Noop,
                        &start.session_id,
                        &pcm16_base64_from_f32(chunk),
                    )
                    .await
                    .expect("chunk decodes");
                    if result.partial.is_empty() {
                        continue;
                    }
                    if partials.last().map(|p| p == &result.partial) != Some(true) {
                        partials.push(result.partial);
                    }
                }

                let final_ = voice_stream_stop_core(&EventEmitter::Noop, &start.session_id)
                    .await
                    .expect("stop flushes and finalizes");
                // The session is gone after stop: a second stop must be an
                // error, and cancel reports nothing to cancel.
                assert!(
                    voice_stream_stop_core(&EventEmitter::Noop, &start.session_id)
                        .await
                        .is_err()
                );
                assert!(!voice_stream_cancel_core(&start.session_id).cancelled);

                // Engine-level assertions: streaming produced incremental
                // partials, and the flushed final matches the last partial.
                assert!(
                    partials.len() >= 2,
                    "expected several partials, got {partials:?}"
                );
                assert!(!final_.text.is_empty(), "final transcript is empty");
                assert_eq!(final_.text, *partials.last().unwrap());
                // Known-good decode of the official sample (PoC README).
                assert!(
                    final_.text.contains("介绍"),
                    "unexpected transcript: {}",
                    final_.text
                );
            });
        });
    }

    /// f32 samples → base64 PCM16, the wire format `voice_stream_chunk` eats.
    fn pcm16_base64_from_f32(samples: &[f32]) -> String {
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|s| {
                let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                v.to_le_bytes()
            })
            .collect();
        BASE64.encode(&bytes)
    }
}
