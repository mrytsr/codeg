//! Local speech-to-text for the composer's voice button.
//!
//! The audio is captured in the renderer as 16 kHz mono PCM16 and wrapped in a
//! WAV there (see `src/lib/voice-input.ts`). This module persists those bytes
//! to a temporary file and runs the bundled `whisper-cli` over them. No audio
//! is ever uploaded: the only network use is the one-time decoder + model
//! download in [`ensure_voice_ready_core`], which the UI triggers on first use
//! and streams progress for (`voice://prepare`).
//!
//! Both the Tauri command and the web handler call the same `_core` functions,
//! so the desktop app and `yoyocode-server` share one implementation.
//! Resolution order for the binary / model:
//!   1. `CODEG_WHISPER_BIN` / `CODEG_WHISPER_MODEL` environment overrides;
//!   2. `CODEG_DATA_DIR/voice/` (the documented install location);
//!   3. the app data directory (`dirs::data_dir()/codeg/voice/`);
//!   4. `whisper-cli` on PATH (model still needs one of the paths above).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tokio::process::Command as AsyncCommand;
use tokio::time::timeout;

use crate::app_error::AppCommandError;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// The WAV the renderer sends is 16 kHz mono PCM16 — a few seconds is enough
/// for a composer prompt. 8 MiB is ~3.5 minutes; larger payloads are refused
/// before they reach the decoder.
pub const VOICE_WAV_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Whisper on a long prompt can take a while on CPU. Past this we kill the
/// child rather than leave the composer spinning forever.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(120);
/// Downloading a ~150 MB model must be bounded so a wedged CDN cannot leave a
/// prepare request hanging forever.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Progress topic shared with the frontend (`listenVoicePrepare`).
pub const VOICE_PREPARE_EVENT: &str = "voice://prepare";

/// Rolling whisper.cpp build tag that actually publishes prebuilt binaries
/// (stable `v1.9.x` tags carry no assets). Pinned so a release cannot swap the
/// decoder underneath us.
const WHISPER_RELEASE: &str = "b5454";
const MODEL_NAME: &str = "ggml-base.bin";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
/// First turn of Whisper output on silence. Mirrors the noise tokens the
/// `pi-voice` and `pivoice` projects strip (`anistark/pivoice/src/stt.ts`).
const NOISE_TOKENS: [&str; 8] = [
    "[BLANK_AUDIO]",
    "[NOISE]",
    "[MUSIC]",
    "[SILENCE]",
    "[silence]",
    "(silence)",
    "[Applause]",
    "[applause]",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscribeResult {
    pub text: String,
    /// Always `"whisper.cpp"` today; kept on the wire so a future engine can
    /// be added without another frontend change.
    pub engine: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VoicePrepareStage {
    DownloadingBinary,
    DownloadingModel,
    Extracting,
    /// Streaming ASR (sherpa-onnx) model archive — a separate download from
    /// the whisper model, shared on the same `voice://prepare` topic.
    DownloadingStreamModel,
    /// Decompressing + loading the streaming model into memory (~1.5 s).
    LoadingModel,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePrepareProgress {
    pub stage: VoicePrepareStage,
    /// 0..=100 when the content length is known, otherwise -1.
    pub percent: i32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub available: bool,
    pub binary: Option<String>,
    pub model: Option<String>,
    /// Human-readable reason when `available` is false.
    pub reason: Option<String>,
    /// True when this platform has no prebuilt decoder (macOS) and the user
    /// must install whisper.cpp themselves. The UI shows install guidance.
    pub needs_manual_install: bool,
}

// ─── Path resolution ───────────────────────────────────────────────────

/// Directory the prepare step installs into. Kept as one function so the
/// status, prepare and transcribe commands cannot drift apart.
pub fn voice_data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CODEG_DATA_DIR").filter(|s| !s.is_empty()) {
        return PathBuf::from(dir).join("voice");
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("codeg")
        .join("voice")
}

fn binary_name() -> &'static str {
    if cfg!(windows) {
        "whisper-cli.exe"
    } else {
        "whisper-cli"
    }
}

fn candidate_model_names() -> [&'static str; 3] {
    ["ggml-base.bin", "ggml-small.bin", "ggml-tiny.bin"]
}

/// The prebuilt archive asset for this platform, or `None` on macOS where
/// whisper.cpp ships an xcframework but no CLI binary.
fn binary_asset() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    {
        #[cfg(target_arch = "aarch64")]
        return Some("whisper-bin-win-cpu-arm64.zip");
        #[cfg(not(target_arch = "aarch64"))]
        return Some("whisper-bin-x64.zip");
    }
    #[cfg(target_os = "linux")]
    {
        #[cfg(target_arch = "aarch64")]
        return Some("whisper-bin-ubuntu-arm64.tar.gz");
        #[cfg(not(target_arch = "aarch64"))]
        return Some("whisper-bin-ubuntu-x64.tar.gz");
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    return None;
}

/// Resolve the decoder executable. An explicit env override always wins;
/// otherwise look in the install directory, then on PATH.
pub fn resolve_whisper_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CODEG_WHISPER_BIN").filter(|s| !s.is_empty()) {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let in_data = voice_data_dir().join(binary_name());
    if in_data.is_file() {
        return Some(in_data);
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary_name());
        if !candidate.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if candidate
                .metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
            {
                return Some(candidate);
            }
        }
        #[cfg(not(unix))]
        return Some(candidate);
    }
    None
}

/// Resolve the ggml model. An explicit env override wins; otherwise the first
/// installed model in the documented directory is used (base → small → tiny).
pub fn resolve_whisper_model() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("CODEG_WHISPER_MODEL").filter(|s| !s.is_empty()) {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    let dir = voice_data_dir();
    candidate_model_names()
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

pub fn voice_status_core() -> VoiceStatus {
    let binary = resolve_whisper_binary();
    let model = resolve_whisper_model();
    let manual = binary_asset().is_none() && binary.is_none();
    let reason = if manual {
        Some(
            "macOS has no prebuilt whisper-cli: run `brew install whisper-cpp` (or set CODEG_WHISPER_BIN)".to_string(),
        )
    } else if binary.is_none() {
        Some(format!(
            "whisper-cli not installed yet (looked in {})",
            voice_data_dir().display()
        ))
    } else if model.is_none() {
        Some(format!(
            "no ggml model found in {}",
            voice_data_dir().display()
        ))
    } else {
        None
    };
    VoiceStatus {
        available: reason.is_none(),
        binary: binary.map(|p| p.to_string_lossy().into_owned()),
        model: model.map(|p| p.to_string_lossy().into_owned()),
        reason,
        needs_manual_install: manual,
    }
}

// ─── One-time preparation (download + extract) ─────────────────────────

/// Broadcast one `voice://prepare` progress frame. Shared with `voice_stream`
/// (the sherpa-onnx model download rides the same topic).
pub(crate) fn emit_progress(
    emitter: &EventEmitter,
    stage: VoicePrepareStage,
    percent: i32,
    message: &str,
) {
    emit_event(
        emitter,
        VOICE_PREPARE_EVENT,
        VoicePrepareProgress {
            stage,
            percent,
            message: message.to_string(),
        },
    );
}

/// Stream `url` to `dest`, reporting percentage through `on_percent`. Shared
/// with `voice_stream` (the sherpa-onnx model download uses the same pipe).
pub(crate) async fn download_file<F>(
    url: &str,
    dest: &Path,
    on_percent: F,
) -> Result<(), AppCommandError>
where
    F: Fn(i32),
{
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| AppCommandError::network(format!("http client: {e}")))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("request failed: {e}")))?;
    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "HTTP {} for {url}",
            response.status()
        )));
    }
    let total = response.content_length();
    let mut downloaded: u64 = 0;
    let mut last_percent: i32 = -1;
    let mut stream = response.bytes_stream();
    let mut file = std::fs::File::create(dest)
        .map_err(|e| AppCommandError::io_error(format!("create download file: {e}")))?;
    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppCommandError::network(format!("read chunk: {e}")))?;
        file.write_all(&chunk)
            .map_err(|e| AppCommandError::io_error(format!("write download: {e}")))?;
        downloaded += chunk.len() as u64;
        let percent = match total {
            Some(t) if t > 0 => ((downloaded as f64 / t as f64) * 100.0) as i32,
            _ => -1,
        };
        if percent > last_percent {
            last_percent = percent;
            on_percent(percent);
        }
    }
    on_percent(100);
    Ok(())
}

/// Find `whisper-cli` anywhere under `root` (archives wrap it in a folder).
fn find_cli(root: &Path) -> Option<PathBuf> {
    let wanted = binary_name();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_name().to_string_lossy() == wanted {
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

fn extract_archive(archive: &Path, dest: &Path) -> Result<(), AppCommandError> {
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        let file = std::fs::File::open(archive)
            .map_err(|e| AppCommandError::io_error(format!("open zip: {e}")))?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|e| AppCommandError::io_error(format!("read zip: {e}")))?;
        zip.extract(dest)
            .map_err(|e| AppCommandError::io_error(format!("extract zip: {e}")))?;
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let file = std::fs::File::open(archive)
            .map_err(|e| AppCommandError::io_error(format!("open tar.gz: {e}")))?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut tar = tar::Archive::new(gz);
        tar.unpack(dest)
            .map_err(|e| AppCommandError::io_error(format!("extract tar.gz: {e}")))?;
    } else {
        return Err(AppCommandError::invalid_input(format!(
            "unsupported archive: {name}"
        )));
    }
    #[cfg(unix)]
    if let Some(cli) = find_cli(dest) {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = std::fs::metadata(&cli).map(|m| m.permissions()) {
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&cli, perms);
        }
    }
    Ok(())
}

/// Download and install the decoder + model on first use. Idempotent: a
/// second call with everything present is a no-op. Progress is broadcast on
/// `voice://prepare` so the composer can show a real percentage.
pub async fn ensure_voice_ready_core(
    emitter: &EventEmitter,
) -> Result<VoiceStatus, AppCommandError> {
    // Two composer buttons (or two windows) can ask at once. Serialize here so
    // only one download runs; the second caller sees the finished install.
    static PREPARE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = PREPARE_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    // Already ready (or user supplied overrides) — nothing to do.
    if resolve_whisper_binary().is_some() && resolve_whisper_model().is_some() {
        emit_progress(emitter, VoicePrepareStage::Done, 100, "Ready");
        return Ok(voice_status_core());
    }

    let dir = voice_data_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppCommandError::io_error(format!("create voice dir: {e}")))?;
    let cli_dest = dir.join(binary_name());
    let model_dest = dir.join(MODEL_NAME);

    // 1. Decoder binary. Resolve rather than only testing `cli_dest`: a
    //    brew/PATH-installed whisper-cli is just as usable, and macOS has no
    //    prebuilt asset at all, so a missing local copy must not force a
    //    download that cannot succeed.
    if resolve_whisper_binary().is_none() && std::env::var_os("CODEG_WHISPER_BIN").is_none() {
        let asset = binary_asset().ok_or_else(|| {
            AppCommandError::dependency_missing(
                "no prebuilt whisper-cli for this platform; install whisper.cpp manually",
            )
        })?;
        let api = format!(
            "https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/{WHISPER_RELEASE}"
        );
        emit_progress(
            emitter,
            VoicePrepareStage::DownloadingBinary,
            -1,
            "Looking up decoder...",
        );
        let client = reqwest::Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .build()
            .map_err(|e| AppCommandError::network(format!("http client: {e}")))?;
        let release: serde_json::Value = client
            .get(&api)
            .header("user-agent", "codeg-voice")
            .send()
            .await
            .map_err(|e| AppCommandError::network(format!("release lookup: {e}")))?
            .json()
            .await
            .map_err(|e| AppCommandError::network(format!("release json: {e}")))?;
        let asset_url = release["assets"]
            .as_array()
            .and_then(|assets| assets.iter().find(|a| a["name"] == asset))
            .and_then(|a| a["browser_download_url"].as_str())
            .map(str::to_string)
            .ok_or_else(|| {
                AppCommandError::dependency_missing(format!(
                    "decoder asset {asset} missing from release {WHISPER_RELEASE}"
                ))
            })?;

        let tmp = dir.join(format!(".download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp)
            .map_err(|e| AppCommandError::io_error(format!("create temp: {e}")))?;
        let archive = tmp.join(asset);
        let download = download_file(&asset_url, &archive, |pct| {
            emit_progress(
                emitter,
                VoicePrepareStage::DownloadingBinary,
                pct,
                &format!("Downloading decoder... {pct}%"),
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
            "Extracting decoder...",
        );
        let extract = extract_archive(&archive, &tmp);
        if extract.is_err() {
            let _ = std::fs::remove_dir_all(&tmp);
        }
        extract?;
        let found = find_cli(&tmp).ok_or_else(|| {
            let _ = std::fs::remove_dir_all(&tmp);
            AppCommandError::dependency_missing("archive did not contain whisper-cli")
        })?;
        std::fs::copy(&found, &cli_dest)
            .map_err(|e| AppCommandError::io_error(format!("install decoder: {e}")))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&cli_dest)
                .map_err(|e| AppCommandError::io_error(e.to_string()))?
                .permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&cli_dest, perms);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // 2. Model. Same rule: accept any resolved model (data dir or override).
    if resolve_whisper_model().is_none() && std::env::var_os("CODEG_WHISPER_MODEL").is_none() {
        let tmp_model = dir.join(format!(".model-{}.part", uuid::Uuid::new_v4()));
        let download = download_file(MODEL_URL, &tmp_model, |pct| {
            emit_progress(
                emitter,
                VoicePrepareStage::DownloadingModel,
                pct,
                &format!("Downloading speech model... {pct}%"),
            )
        })
        .await;
        if download.is_err() {
            let _ = std::fs::remove_file(&tmp_model);
        }
        download?;
        std::fs::rename(&tmp_model, &model_dest)
            .or_else(|_| {
                std::fs::copy(&tmp_model, &model_dest).map(|_| {
                    let _ = std::fs::remove_file(&tmp_model);
                })
            })
            .map_err(|e: std::io::Error| {
                AppCommandError::io_error(format!("install model: {e}"))
            })?;
    }

    emit_progress(emitter, VoicePrepareStage::Done, 100, "Ready");
    Ok(voice_status_core())
}

// ─── Text cleanup ──────────────────────────────────────────────────────

/// Strip Whisper's silence-hallucination tokens and collapse the whitespace
/// it inserts around segment boundaries. Pure so it can be unit-tested
/// without a decoder.
pub fn clean_transcript(raw: &str) -> String {
    let mut text = raw.trim().to_string();
    for token in NOISE_TOKENS {
        text = text.replace(token, " ");
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Map a UI locale to the two-letter code Whisper expects. Only Chinese gets
/// a special case: Whisper wants `zh`, Web Speech wants `zh-CN`.
pub fn whisper_language(language: &str) -> &str {
    let lower = language.trim().to_ascii_lowercase();
    if lower.starts_with("zh") {
        "zh"
    } else {
        "en"
    }
}

// ─── Audio persistence ─────────────────────────────────────────────────

fn decode_wav(data_base64: &str) -> Result<Vec<u8>, AppCommandError> {
    let bytes = BASE64
        .decode(data_base64)
        .map_err(|e| AppCommandError::invalid_input(format!("invalid voice audio payload: {e}")))?;
    if bytes.is_empty() {
        return Err(AppCommandError::invalid_input("empty voice audio payload"));
    }
    if bytes.len() > VOICE_WAV_MAX_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "voice audio too large: {} bytes (limit {VOICE_WAV_MAX_BYTES})",
            bytes.len()
        )));
    }
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(AppCommandError::invalid_input(
            "voice audio must be a PCM WAV file",
        ));
    }
    Ok(bytes)
}

// ─── Shared core ───────────────────────────────────────────────────────

/// Transcribe a base64-encoded WAV with the local whisper.cpp decoder.
pub async fn voice_transcribe_core(
    data_base64: &str,
    language: Option<&str>,
) -> Result<VoiceTranscribeResult, AppCommandError> {
    let wav = decode_wav(data_base64)?;
    let binary = resolve_whisper_binary().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "whisper-cli is not installed yet; local voice will prepare on first use",
        )
    })?;
    let model = resolve_whisper_model().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "no whisper ggml model yet; local voice will prepare on first use",
        )
    })?;

    let tmp_dir = std::env::temp_dir().join(format!("codeg-voice-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| AppCommandError::io_error(format!("cannot create voice temp dir: {e}")))?;
    let wav_path = tmp_dir.join("input.wav");
    let result = run_decoder(&binary, &model, &wav_path, &wav, language).await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

async fn run_decoder(
    binary: &Path,
    model: &Path,
    wav_path: &Path,
    wav: &[u8],
    language: Option<&str>,
) -> Result<VoiceTranscribeResult, AppCommandError> {
    std::fs::write(wav_path, wav)
        .map_err(|e| AppCommandError::io_error(format!("cannot write voice audio: {e}")))?;
    let lang = whisper_language(language.unwrap_or("en"));
    let model_display = model.to_string_lossy().into_owned();

    let child = AsyncCommand::new(binary)
        .arg("-m")
        .arg(model)
        .arg("-f")
        .arg(wav_path)
        .arg("-l")
        .arg(lang)
        .arg("--no-timestamps")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            AppCommandError::external_command("failed to start whisper-cli", e.to_string())
        })?;

    let output = timeout(TRANSCRIBE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            AppCommandError::external_command(
                "whisper-cli timed out",
                format!("exceeded {}s", TRANSCRIBE_TIMEOUT.as_secs()),
            )
        })?
        .map_err(|e| AppCommandError::external_command("whisper-cli failed", e.to_string()))?;

    if !output.status.success() {
        return Err(AppCommandError::external_command(
            "whisper-cli exited with an error",
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(VoiceTranscribeResult {
        text: clean_transcript(&String::from_utf8_lossy(&output.stdout)),
        engine: "whisper.cpp".to_string(),
        model: model_display,
    })
}

// ─── Tauri commands (desktop only) ─────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn voice_transcribe(
    data_base64: String,
    language: Option<String>,
) -> Result<VoiceTranscribeResult, AppCommandError> {
    voice_transcribe_core(&data_base64, language.as_deref()).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn voice_ensure_ready(app: tauri::AppHandle) -> Result<VoiceStatus, AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    ensure_voice_ready_core(&emitter).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn voice_status() -> VoiceStatus {
    voice_status_core()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_noise_tokens_and_normalizes_whitespace() {
        assert_eq!(
            clean_transcript(" [BLANK_AUDIO] hello   world [NOISE] "),
            "hello world"
        );
        assert_eq!(clean_transcript("  \n [silence] \t"), "");
    }

    #[test]
    fn maps_chinese_variants_to_zh() {
        assert_eq!(whisper_language("zh-CN"), "zh");
        assert_eq!(whisper_language("ZH-tw"), "zh");
        assert_eq!(whisper_language("en-US"), "en");
        assert_eq!(whisper_language("ja-JP"), "en");
    }

    #[test]
    fn rejects_non_wav_payloads() {
        let bad = BASE64.encode(b"not a wav at all");
        assert!(decode_wav(&bad).is_err());
        assert!(decode_wav("not base64!!").is_err());
        assert!(decode_wav(&BASE64.encode([])).is_err());
    }

    #[test]
    fn accepts_a_44_byte_wav_header() {
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&[36, 0, 0, 0]);
        wav.extend_from_slice(b"WAVEfmt ");
        wav.resize(44, 0);
        assert!(decode_wav(&BASE64.encode(&wav)).is_ok());
    }

    #[test]
    fn binary_asset_matches_platform_or_is_absent() {
        // On macOS there is no prebuilt CLI; elsewhere there must be one.
        #[cfg(target_os = "macos")]
        assert!(binary_asset().is_none());
        #[cfg(not(target_os = "macos"))]
        assert!(binary_asset().is_some());
    }
}
