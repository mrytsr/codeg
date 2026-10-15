use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::db::service::folder_command_service;
use crate::models::*;

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderIdParams {
    pub folder_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderCommandParams {
    pub folder_id: i32,
    pub name: String,
    pub command: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderCommandParams {
    pub id: i32,
    pub name: Option<String>,
    pub command: Option<String>,
    pub sort_order: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderCommandParams {
    pub id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderFolderCommandsParams {
    pub folder_id: i32,
    pub ids: Vec<i32>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn list_folder_commands(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderIdParams>,
) -> Result<Json<Vec<FolderCommandInfo>>, AppCommandError> {
    let db = &state.db;
    let result = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn create_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let db = &state.db;
    let result =
        folder_command_service::create(&db.conn, params.folder_id, &params.name, &params.command)
            .await
            .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn update_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let db = &state.db;
    let result = folder_command_service::update(
        &db.conn,
        params.id,
        params.name,
        params.command,
        params.sort_order,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn delete_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DeleteFolderCommandParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = &state.db;
    folder_command_service::delete(&db.conn, params.id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn reorder_folder_commands(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ReorderFolderCommandsParams>,
) -> Result<Json<()>, AppCommandError> {
    let db = &state.db;
    folder_command_service::reorder(&db.conn, params.folder_id, params.ids)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFolderCommandsParams {
    pub folder_id: i32,
    pub folder_path: String,
}

pub async fn sync_folder_commands_from_package_json(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SyncFolderCommandsParams>,
) -> Result<Json<Vec<FolderCommandInfo>>, AppCommandError> {
    let result = crate::commands::folder_commands::sync_folder_commands_core(
        &state.db.conn,
        params.folder_id,
        params.folder_path,
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}
