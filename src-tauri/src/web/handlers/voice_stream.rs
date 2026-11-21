use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::voice_stream::{
    voice_stream_cancel_core, voice_stream_chunk_core, voice_stream_prepare_core,
    voice_stream_start_core, voice_stream_status_core, voice_stream_stop_core,
    VoiceStreamCancelResult, VoiceStreamChunkResult, VoiceStreamFinal, VoiceStreamStartResult,
    VoiceStreamStatus,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamChunkParams {
    pub session_id: String,
    pub pcm16_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStreamSessionParams {
    pub session_id: String,
}

pub async fn voice_stream_status(
    Extension(_state): Extension<Arc<AppState>>,
) -> Json<VoiceStreamStatus> {
    Json(voice_stream_status_core())
}

/// First-use model download + recognizer load. Progress is broadcast on
/// `voice://prepare` through the shared event bridge (Tauri + WS).
pub async fn voice_stream_prepare(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<VoiceStreamStatus>, AppCommandError> {
    let status = voice_stream_prepare_core(&state.emitter).await?;
    Ok(Json(status))
}

pub async fn voice_stream_start(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<VoiceStreamStartResult>, AppCommandError> {
    let result = voice_stream_start_core(&state.emitter).await?;
    Ok(Json(result))
}

/// One PCM chunk; partials stream back on `voice://partial`. The response
/// also carries the current transcript for clients that skip the events.
pub async fn voice_stream_chunk(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<VoiceStreamChunkParams>,
) -> Result<Json<VoiceStreamChunkResult>, AppCommandError> {
    let result =
        voice_stream_chunk_core(&state.emitter, &params.session_id, &params.pcm16_base64).await?;
    Ok(Json(result))
}

/// Flush + finalize. Returns the full transcript for the recording.
pub async fn voice_stream_stop(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<VoiceStreamSessionParams>,
) -> Result<Json<VoiceStreamFinal>, AppCommandError> {
    let result = voice_stream_stop_core(&state.emitter, &params.session_id).await?;
    Ok(Json(result))
}

pub async fn voice_stream_cancel(
    Extension(_state): Extension<Arc<AppState>>,
    Json(params): Json<VoiceStreamSessionParams>,
) -> Json<VoiceStreamCancelResult> {
    Json(voice_stream_cancel_core(&params.session_id))
}
