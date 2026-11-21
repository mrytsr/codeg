use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::voice::{
    ensure_voice_ready_core, voice_status_core, voice_transcribe_core, VoiceStatus,
    VoiceTranscribeResult,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscribeParams {
    pub data_base64: String,
    pub language: Option<String>,
}

pub async fn voice_transcribe(
    Extension(_state): Extension<Arc<AppState>>,
    Json(params): Json<VoiceTranscribeParams>,
) -> Result<Json<VoiceTranscribeResult>, AppCommandError> {
    let result = voice_transcribe_core(&params.data_base64, params.language.as_deref()).await?;
    Ok(Json(result))
}

/// First-use download of the decoder + model. Progress is broadcast on
/// `voice://prepare` through the shared event bridge (Tauri + WS).
pub async fn voice_ensure_ready(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<VoiceStatus>, AppCommandError> {
    let status = ensure_voice_ready_core(&state.emitter).await?;
    Ok(Json(status))
}

pub async fn voice_status(
    Extension(_state): Extension<Arc<AppState>>,
) -> Result<Json<VoiceStatus>, AppCommandError> {
    Ok(Json(voice_status_core()))
}
