use std::sync::Arc;

use axum::{extract::Extension, Json};
use sea_orm::DatabaseConnection;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::db::error::DbError;
use crate::db::service::folder_command_service;
use crate::models::*;

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFolderCommandsParams {
    pub folder_id: i32,
    /// See [`visible_to_client`].
    #[serde(default)]
    pub include_local: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderCommandParams {
    pub folder_id: i32,
    pub name: String,
    pub command: String,
    pub run_local: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFolderCommandParams {
    pub id: i32,
    pub name: Option<String>,
    pub command: Option<String>,
    pub sort_order: Option<i32>,
    pub run_local: Option<bool>,
    /// See [`visible_to_client`].
    #[serde(default)]
    pub include_local: bool,
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

/// The commands a client is shown. One the desktop app runs on its own
/// machine goes only to a client that says it knows that flag: an older one
/// would run the command's text in a terminal here, on the wrong machine.
fn visible_to_client(
    commands: Vec<FolderCommandInfo>,
    include_local: bool,
) -> Vec<FolderCommandInfo> {
    if include_local {
        return commands;
    }
    commands.into_iter().filter(|c| !c.run_local).collect()
}

pub async fn list_folder_commands(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListFolderCommandsParams>,
) -> Result<Json<Vec<FolderCommandInfo>>, AppCommandError> {
    let db = &state.db;
    let result = folder_command_service::list_by_folder(&db.conn, params.folder_id)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(visible_to_client(result, params.include_local)))
}

pub async fn create_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let db = &state.db;
    let result = folder_command_service::create(
        &db.conn,
        params.folder_id,
        &params.name,
        &params.command,
        params.run_local.unwrap_or(false),
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

pub async fn update_folder_command(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateFolderCommandParams>,
) -> Result<Json<FolderCommandInfo>, AppCommandError> {
    let result = update_for_client(&state.db.conn, params)
        .await
        .map_err(AppCommandError::from)?;
    Ok(Json(result))
}

async fn update_for_client(
    conn: &DatabaseConnection,
    params: UpdateFolderCommandParams,
) -> Result<FolderCommandInfo, DbError> {
    // A client that isn't shown a local command (see `visible_to_client`) can
    // only hold its id from before it became one: to that client it is gone.
    if !params.include_local && folder_command_service::is_run_local(conn, params.id).await? {
        return Err(DbError::NotFound(format!("FolderCommand {}", params.id)));
    }
    folder_command_service::update(
        conn,
        params.id,
        params.name,
        params.command,
        params.sort_order,
        params.run_local,
    )
    .await
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
    /// See [`visible_to_client`].
    #[serde(default)]
    pub include_local: bool,
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
    Ok(Json(visible_to_client(result, params.include_local)))
}
