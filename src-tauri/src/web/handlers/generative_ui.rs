//! HTTP handlers for the generative-UI switch — the web-mode mirror of the
//! Tauri commands in `commands::generative_ui`, sharing its core helpers so
//! the save + skill cleanup + broadcast chain is identical across transports.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::generative_ui::{
    load_generative_ui_settings, set_generative_ui_settings_core, GenerativeUiSettings,
};

pub async fn get_generative_ui_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<GenerativeUiSettings>, AppCommandError> {
    Ok(Json(load_generative_ui_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetGenerativeUiSettingsParams {
    pub settings: GenerativeUiSettings,
}

pub async fn set_generative_ui_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetGenerativeUiSettingsParams>,
) -> Result<Json<GenerativeUiSettings>, AppCommandError> {
    let saved =
        set_generative_ui_settings_core(&state.db.conn, &state.emitter, params.settings).await?;
    Ok(Json(saved))
}
