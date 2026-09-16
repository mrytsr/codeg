use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::web::event_bridge::{emit_event, EventEmitter};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginStatus {
    /// Present where the pinned opencode actually looks.
    Installed,
    /// Present only under the pre-1.18 flat `node_modules/`, which current
    /// opencode never reads.
    ///
    /// A distinct state rather than a flavour of `Installed`, because the
    /// install action only acts on things that are NOT installed: folding this
    /// into `Installed` would paint the row green, exclude it from the install
    /// pass, and leave opencode re-fetching the package from the registry on
    /// every start — the failure it looks most like it fixed.
    NeedsMigration,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub declared_spec: String,
    pub installed_version: Option<String>,
    pub status: PluginStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginCheckSummary {
    pub config_path: PathBuf,
    pub cache_dir: PathBuf,
    pub plugins: Vec<PluginInfo>,
    pub has_project_config_hint: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallEventKind {
    Started,
    Log,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginInstallEvent {
    pub task_id: String,
    pub kind: PluginInstallEventKind,
    pub payload: String,
}

/// Well-known paths for opencode configuration and cache.
///
/// OpenCode follows XDG conventions on all platforms:
///   config: $XDG_CONFIG_HOME/opencode  or  ~/.config/opencode
///   cache:  $XDG_CACHE_HOME/opencode   or  ~/.cache/opencode
///
/// We must NOT use `dirs::config_dir()` / `dirs::cache_dir()` because on
/// macOS those return ~/Library/Application Support and ~/Library/Caches,
/// while opencode always uses the XDG paths.
fn opencode_config_path() -> Option<PathBuf> {
    xdg_config_home().map(|d| d.join("opencode").join("opencode.json"))
}

fn opencode_cache_dir() -> Option<PathBuf> {
    xdg_cache_home().map(|d| d.join("opencode"))
}

pub(crate) fn xdg_config_home() -> Option<PathBuf> {
    // An empty XDG_CONFIG_HOME must fall back to ~/.config, not resolve to a
    // relative "opencode/..." path (matches the XDG_DATA_HOME handling).
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
}

fn xdg_cache_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".cache")))
}

/// A plugin spec that names a local path rather than an npm package.
///
/// opencode resolves these through `resolvePathPluginTarget`, which never
/// touches the package cache, so none of the layout logic below applies.
fn is_path_spec(spec: &str) -> bool {
    spec.starts_with('.')
        || spec.starts_with('/')
        || spec.starts_with("file:")
        || spec.contains("://")
}

/// The spec opencode uses as its package-directory KEY.
///
/// Mirrors `resolvePluginTarget` in opencode 1.18.31: a bare package name
/// becomes `<name>@latest`, anything already carrying a version or tag is used
/// verbatim. Getting this wrong does not fail loudly — it just points codeg at
/// a directory opencode will never look in.
pub(crate) fn effective_spec(declared_spec: &str, name: &str) -> String {
    if declared_spec == name {
        format!("{name}@latest")
    } else {
        declared_spec.to_string()
    }
}

/// Mirrors `Npm.sanitize` in opencode 1.18.31: on Windows the characters that
/// cannot appear in a path become `_`. A deliberate no-op everywhere else —
/// the directory name has to match opencode's byte for byte, and opencode
/// gates this on `process.platform === "win32"`.
pub(crate) fn sanitize_spec(spec: &str) -> String {
    if !cfg!(windows) {
        return spec.to_string();
    }
    spec.chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect()
}

/// `<cache>/packages/<sanitize(effective_spec)>` — the per-package install root
/// opencode 1.18.31 uses (`Npm.add`'s `directory()`).
pub(crate) fn plugin_package_dir(cache_dir: &Path, effective_spec: &str) -> PathBuf {
    cache_dir
        .join("packages")
        .join(sanitize_spec(effective_spec))
}

/// Where opencode looks for the module itself. Its own hit test is a bare
/// existence check on this directory (`Npm.add`'s fast path), which is why a
/// `bun add` into the right parent satisfies it without codeg having to
/// reproduce arborist's bookkeeping.
fn modern_pkg_json(cache_dir: &Path, effective_spec: &str, name: &str) -> PathBuf {
    plugin_package_dir(cache_dir, effective_spec)
        .join("node_modules")
        .join(name)
        .join("package.json")
}

/// The pre-1.18 flat layout codeg used to both write and check.
fn legacy_pkg_json(cache_dir: &Path, name: &str) -> PathBuf {
    cache_dir
        .join("node_modules")
        .join(name)
        .join("package.json")
}

fn read_pkg_version(pkg_json: &Path) -> Option<String> {
    let content = std::fs::read_to_string(pkg_json).ok()?;
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

/// Check whether a project directory contains any opencode configuration file.
fn has_project_opencode_config(project_root: &Path) -> bool {
    let candidates = [
        project_root.join("opencode.json"),
        project_root.join("opencode.jsonc"),
        project_root.join(".opencode").join("opencode.json"),
        project_root.join(".opencode").join("opencode.jsonc"),
    ];
    candidates.iter().any(|p| p.exists())
}

/// Inspect `~/.config/opencode/opencode.json` and `~/.cache/opencode/node_modules/`
/// to determine which declared plugins are installed and which are missing.
pub fn check_opencode_plugins(project_root: Option<&Path>) -> Result<PluginCheckSummary, String> {
    let config_path = opencode_config_path()
        .ok_or_else(|| "Cannot determine opencode config directory".to_string())?;
    let cache_dir = opencode_cache_dir()
        .ok_or_else(|| "Cannot determine opencode cache directory".to_string())?;

    let has_project_config_hint = project_root
        .map(has_project_opencode_config)
        .unwrap_or(false);

    // If config file doesn't exist, there's nothing to check
    if !config_path.exists() {
        return Ok(PluginCheckSummary {
            config_path,
            cache_dir,
            plugins: vec![],
            has_project_config_hint,
        });
    }

    // Read and parse JSON
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {e}", config_path.display()))?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", config_path.display()))?;

    // Extract plugin[] array
    let plugin_array = match doc.get("plugin") {
        Some(serde_json::Value::Array(arr)) => arr,
        Some(_) => {
            return Ok(PluginCheckSummary {
                config_path,
                cache_dir,
                plugins: vec![],
                has_project_config_hint,
            });
        }
        None => {
            return Ok(PluginCheckSummary {
                config_path,
                cache_dir,
                plugins: vec![],
                has_project_config_hint,
            });
        }
    };

    // Parse specs, dedup by name
    let mut seen_names = HashSet::new();
    let mut plugins = Vec::new();

    for item in plugin_array {
        let spec_str = match item.as_str() {
            Some(s) => s,
            None => {
                tracing::warn!("[opencode_plugins] Skipping non-string plugin entry: {item}");
                continue;
            }
        };

        let (name, declared_spec) = match parse_plugin_spec(spec_str) {
            Some(pair) => pair,
            None => {
                tracing::warn!("[opencode_plugins] Skipping invalid plugin spec: {spec_str:?}");
                continue;
            }
        };

        if !seen_names.insert(name.clone()) {
            continue; // duplicate, skip
        }

        // Modern layout first, then the legacy one. The order matters: a
        // package present in BOTH is genuinely installed, and only a
        // legacy-ONLY copy needs migrating.
        let legacy = legacy_pkg_json(&cache_dir, &name);
        let (status, installed_version) = if is_path_spec(&declared_spec) {
            // Path plugins never enter the package cache; opencode loads them
            // straight off disk, so there is no layout to be on the wrong side
            // of.
            if legacy.exists() {
                (PluginStatus::Installed, read_pkg_version(&legacy))
            } else {
                (PluginStatus::Missing, None)
            }
        } else {
            let effective = effective_spec(&declared_spec, &name);
            let modern = modern_pkg_json(&cache_dir, &effective, &name);
            if modern.exists() {
                (PluginStatus::Installed, read_pkg_version(&modern))
            } else if legacy.exists() {
                (PluginStatus::NeedsMigration, read_pkg_version(&legacy))
            } else {
                (PluginStatus::Missing, None)
            }
        };

        plugins.push(PluginInfo {
            name,
            declared_spec,
            installed_version,
            status,
        });
    }

    Ok(PluginCheckSummary {
        config_path,
        cache_dir,
        plugins,
        has_project_config_hint,
    })
}

/// Locate a usable bun binary.
/// Priority: opencode-bundled bun → system bun → error.
pub fn resolve_bun_binary() -> Result<PathBuf, String> {
    let cache_dir = opencode_cache_dir();

    // Try opencode-bundled bun
    if let Some(ref dir) = cache_dir {
        let candidates = if cfg!(windows) {
            vec![dir.join("bin").join("bun.exe")]
        } else {
            vec![dir.join("bin").join("bun")]
        };
        for candidate in candidates {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // Fallback to system bun
    if let Ok(system_bun) = which::which("bun") {
        return Ok(system_bun);
    }

    Err(
        "bun binary not found. Neither opencode-bundled bun (~/.cache/opencode/bin/bun) \
         nor system bun is available."
            .to_string(),
    )
}

/// Detect whether a JSON string contains comments (// or /*).
fn json_has_comments(raw: &str) -> bool {
    raw.contains("//") || raw.contains("/*")
}

/// Write a timestamped backup of a file, keeping only the most recent `keep` copies.
fn write_backup_and_prune(path: &Path, content: &str, keep: usize) -> Result<(), String> {
    let now = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
    let backup_path = path.with_file_name(format!(
        "{}.bak.{now}",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    fs::write(&backup_path, content)
        .map_err(|e| format!("Failed to write backup {}: {e}", backup_path.display()))?;

    // Prune old backups
    let parent = path.parent().ok_or("No parent directory")?;
    let stem = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let prefix = format!("{stem}.bak.");

    let mut backups: Vec<_> = fs::read_dir(parent)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .collect();

    // Sort by name descending (timestamp in name → newest first)
    backups.sort_by_key(|b| std::cmp::Reverse(b.file_name()));

    for old in backups.iter().skip(keep) {
        let _ = fs::remove_file(old.path());
    }

    Ok(())
}

/// Atomically rewrite opencode.json: read → backup → mutate → write temp → rename.
pub(crate) fn atomic_rewrite_opencode_json(
    path: &Path,
    mutator: impl FnOnce(&mut serde_json::Value) -> Result<(), String>,
) -> Result<(), String> {
    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;

    // Try parsing first.  If serde_json succeeds the file is valid JSON
    // and any "//" or "/*" sequences live inside string values — not real
    // comments.  Only reject when parsing *fails* and the raw text looks
    // like it might be JSONC (actual comments would cause a parse error).
    if serde_json::from_str::<serde_json::Value>(&raw).is_err() && json_has_comments(&raw) {
        return Err(
            "opencode.json appears to be JSONC (contains comments). Refusing to rewrite to avoid \
             data loss. Please edit the file manually."
                .to_string(),
        );
    }

    write_backup_and_prune(path, &raw, 3)?;

    let mut doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;

    mutator(&mut doc)?;

    let new_raw =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("Failed to serialize JSON: {e}"))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &new_raw).map_err(|e| format!("Failed to write temp file: {e}"))?;
    fs::rename(&tmp_path, path).map_err(|e| format!("Failed to rename temp file: {e}"))?;

    Ok(())
}

/// Check whether a plugin spec uses a floating version tag like `@latest`.
pub fn spec_has_floating_version(spec: &str) -> bool {
    if let Some((_, full)) = parse_plugin_spec(spec) {
        full.ends_with("@latest")
    } else {
        false
    }
}

/// After a successful install, replace `@latest` specs in opencode.json with
/// the actual installed version read from node_modules.  This prevents
/// opencode from hitting the npm registry on every startup.
fn pin_latest_specs(
    config_path: &Path,
    cache_dir: &Path,
    specs: &[(String, String)], // (name, original_declared_spec)
) -> Result<usize, String> {
    let mut pinned = 0;

    // Collect name → installed_version for specs that have @latest.
    let mut pin_map: Vec<(String, String)> = Vec::new();
    for (name, declared) in specs {
        if !declared.ends_with("@latest") {
            continue;
        }
        let effective = effective_spec(declared, name);
        // Modern layout first, legacy as the fallback, so a version can still
        // be read on a machine that has not been migrated yet.
        let version = read_pkg_version(&modern_pkg_json(cache_dir, &effective, name))
            .or_else(|| read_pkg_version(&legacy_pkg_json(cache_dir, name)));
        if let Some(version) = version {
            pin_map.push((name.clone(), version));
        }
    }

    if pin_map.is_empty() {
        return Ok(0);
    }

    atomic_rewrite_opencode_json(config_path, |doc| {
        if let Some(arr) = doc
            .as_object_mut()
            .and_then(|obj| obj.get_mut("plugin"))
            .and_then(|v| v.as_array_mut())
        {
            for item in arr.iter_mut() {
                if let Some(spec_str) = item.as_str() {
                    if let Some((parsed_name, _)) = parse_plugin_spec(spec_str) {
                        if let Some((_, version)) = pin_map.iter().find(|(n, _)| *n == parsed_name)
                        {
                            *item = serde_json::Value::String(format!("{parsed_name}@{version}"));
                            pinned += 1;
                        }
                    }
                }
            }
        }
        Ok(())
    })?;


    // Only NOW, with the config committed, move each package directory to the
    // key the pinned spec produces. opencode keys `packages/<spec>` on the spec
    // it reads from opencode.json, so the two have to agree — but the ORDER
    // decides which way a partial failure fails, and only one of the two
    // recovers on its own:
    //
    //   config first, rename fails -> config says `foo@1.2.3`, directory says
    //     `foo@latest`. opencode reinstalls into the pinned directory once and
    //     the state is consistent again. One unexpected download.
    //   rename first, config write fails -> config still says `foo@latest`
    //     while the directory is `foo@1.2.3`. Detection reads the config, finds
    //     nothing at `foo@latest`, and reports the plugin unmigrated forever;
    //     every retry reinstalls `@latest` and then moves it away again.
    //
    // So the config is written first and this loop is best-effort cleanup.
    for (name, version) in &pin_map {
        let from = plugin_package_dir(cache_dir, &format!("{name}@latest"));
        let to = plugin_package_dir(cache_dir, &format!("{name}@{version}"));
        if from == to || !from.exists() {
            continue;
        }
        if to.exists() {
            // Already at the pinned key (an earlier run, or opencode itself
            // installed it). The `@latest` copy is now redundant.
            let _ = fs::remove_dir_all(&from);
            continue;
        }
        if let Err(e) = fs::rename(&from, &to) {
            // Non-fatal: opencode will reinstall into the pinned directory on
            // its next start. Worth a line in the log rather than silence,
            // because it explains an unexpected network fetch.
            tracing::warn!(
                "[opencode_plugins] could not realign {} -> {}: {e}",
                from.display(),
                to.display()
            );
        }
    }

    Ok(pinned)
}

static PLUGIN_OP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const PLUGIN_INSTALL_EVENT: &str = "app://opencode-plugin-install";

/// Packages that must never be uninstalled (opencode internals).
fn is_protected_package(name: &str) -> bool {
    name.starts_with("@opencode-ai/")
}

fn emit_plugin_event(
    emitter: &EventEmitter,
    task_id: &str,
    kind: PluginInstallEventKind,
    payload: impl Into<String>,
) {
    emit_event(
        emitter,
        PLUGIN_INSTALL_EVENT,
        PluginInstallEvent {
            task_id: task_id.to_string(),
            kind,
            payload: payload.into(),
        },
    );
}

/// Install missing plugins by running `bun add` in the opencode cache directory.
/// Streams progress events to the given emitter.
pub async fn install_missing_plugins(
    names: Option<Vec<String>>,
    task_id: String,
    emitter: &EventEmitter,
) -> Result<(), String> {
    let _guard = PLUGIN_OP_LOCK
        .try_lock()
        .map_err(|_| "Another plugin operation is in progress".to_string())?;

    emit_plugin_event(emitter, &task_id, PluginInstallEventKind::Started, "");

    // Re-check current state
    let summary = check_opencode_plugins(None).inspect_err(|e| {
        emit_plugin_event(emitter, &task_id, PluginInstallEventKind::Failed, e);
    })?;

    // `NeedsMigration` too, not just `Missing`: a legacy-only copy is exactly
    // the case this pass exists to repair, and filtering on `Missing` alone
    // would silently skip it.
    let missing: Vec<&PluginInfo> = summary
        .plugins
        .iter()
        .filter(|p| {
            matches!(
                p.status,
                PluginStatus::Missing | PluginStatus::NeedsMigration
            )
        })
        .filter(|p| match &names {
            Some(list) => list.contains(&p.name),
            None => true,
        })
        .collect();

    if missing.is_empty() {
        // Nothing to install, but still pin any @latest specs
        let all_specs: Vec<(String, String)> = summary
            .plugins
            .iter()
            .map(|p| (p.name.clone(), p.declared_spec.clone()))
            .collect();
        match pin_latest_specs(&summary.config_path, &summary.cache_dir, &all_specs) {
            Ok(n) if n > 0 => {
                emit_plugin_event(
                    emitter,
                    &task_id,
                    PluginInstallEventKind::Log,
                    format!("Pinned {n} @latest plugin(s) to installed versions in opencode.json"),
                );
                emit_plugin_event(
                    emitter,
                    &task_id,
                    PluginInstallEventKind::Completed,
                    format!("Pinned {n} @latest plugin(s) — no missing plugins to install"),
                );
            }
            Err(e) => {
                emit_plugin_event(
                    emitter,
                    &task_id,
                    PluginInstallEventKind::Failed,
                    format!("Failed to pin @latest versions: {e}"),
                );
            }
            _ => {
                emit_plugin_event(
                    emitter,
                    &task_id,
                    PluginInstallEventKind::Completed,
                    "Nothing to install — all plugins are already present",
                );
            }
        }
        return Ok(());
    }

    // (name, declared_spec) for each thing to install. Each gets its OWN
    // directory now, so this is a loop rather than one `bun add` with every
    // spec: opencode keys the package directory on the spec, so a single
    // shared install root would be a directory it never consults.
    let targets: Vec<(String, String)> = missing
        .iter()
        .map(|p| (p.name.clone(), p.declared_spec.clone()))
        .collect();
    let names_display: Vec<&str> = missing.iter().map(|p| p.name.as_str()).collect();

    // Resolve bun
    let bun = resolve_bun_binary().inspect_err(|e| {
        emit_plugin_event(emitter, &task_id, PluginInstallEventKind::Failed, e);
    })?;

    emit_plugin_event(
        emitter,
        &task_id,
        PluginInstallEventKind::Log,
        format!("Installing: {}", names_display.join(", ")),
    );

    for (name, declared_spec) in &targets {
        if is_path_spec(declared_spec) {
            // Not an npm package; `bun add` in a package directory is
            // meaningless for it. Left alone rather than half-handled.
            emit_plugin_event(
                emitter,
                &task_id,
                PluginInstallEventKind::Log,
                format!("Skipping {name}: path plugins are loaded from disk, not installed"),
            );
            continue;
        }
        let effective = effective_spec(declared_spec, name);
        let dir = plugin_package_dir(&summary.cache_dir, &effective);
        if let Err(e) = fs::create_dir_all(&dir) {
            let msg = format!("Failed to create {}: {e}", dir.display());
            emit_plugin_event(emitter, &task_id, PluginInstallEventKind::Failed, &msg);
            return Err(msg);
        }
        run_bun_add(&bun, &dir, declared_spec, &task_id, emitter).await?;
    }

    // Pin @latest specs to the versions actually on disk so opencode does not
    // hit the npm registry on every startup. Pin ALL plugins, not just the
    // ones installed just now, so an already-present @latest gets pinned too.
    //
    // ORDER MATTERS, and not obviously: pinning rewrites `foo@latest` to
    // `foo@1.2.3` in opencode.json, and the package DIRECTORY is keyed on that
    // same spec. Rewriting the config without moving the directory would point
    // opencode at `packages/foo@1.2.3/`, which does not exist, and it would
    // re-download the package it was just handed. `pin_latest_specs` therefore
    // realigns the directory first and only then rewrites the config.
    let spec_pairs: Vec<(String, String)> = summary
        .plugins
        .iter()
        .map(|p| (p.name.clone(), p.declared_spec.clone()))
        .collect();
    match pin_latest_specs(&summary.config_path, &summary.cache_dir, &spec_pairs) {
        Ok(n) if n > 0 => {
            emit_plugin_event(
                emitter,
                &task_id,
                PluginInstallEventKind::Log,
                format!("Pinned {n} @latest plugin(s) to installed versions in opencode.json"),
            );
        }
        Err(e) => {
            emit_plugin_event(
                emitter,
                &task_id,
                PluginInstallEventKind::Log,
                format!("Warning: could not pin @latest versions: {e}"),
            );
        }
        _ => {}
    }

    emit_plugin_event(
        emitter,
        &task_id,
        PluginInstallEventKind::Completed,
        "All plugins installed successfully",
    );
    Ok(())
}

/// One `bun add <spec>` in `dir`, streaming both streams to the install log.
async fn run_bun_add(
    bun: &Path,
    dir: &Path,
    spec: &str,
    task_id: &str,
    emitter: &EventEmitter,
) -> Result<(), String> {
    let mut cmd = crate::process::tokio_command(bun);
    cmd.arg("add")
        .arg(spec)
        .current_dir(dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("Failed to spawn bun: {e}");
        emit_plugin_event(emitter, task_id, PluginInstallEventKind::Failed, &msg);
        msg
    })?;

    // Stream stdout and stderr concurrently
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // `collect_lines_lossy` (not `Lines`/`next_line()`) matters here: bun/npm
    // can emit OEM-codepage bytes (e.g. GBK on a zh-CN Windows) for localized
    // OS-level error text, which `next_line()` chokes on and silently drops —
    // truncating the live install log at the first non-UTF-8 byte. The
    // collected return value is unused (the failure message below is built from
    // the exit code, not captured stderr), so it is discarded.
    let stdout_handle = tokio::spawn({
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        async move {
            if let Some(stdout) = stdout {
                crate::process::collect_lines_lossy(tokio::io::BufReader::new(stdout), |line| {
                    emit_plugin_event(&emitter, &task_id, PluginInstallEventKind::Log, line);
                })
                .await;
            }
        }
    });

    let stderr_handle = tokio::spawn({
        let emitter = emitter.clone();
        let task_id = task_id.to_string();
        async move {
            if let Some(stderr) = stderr {
                crate::process::collect_lines_lossy(tokio::io::BufReader::new(stderr), |line| {
                    emit_plugin_event(&emitter, &task_id, PluginInstallEventKind::Log, line);
                })
                .await;
            }
        }
    });

    let _ = tokio::join!(stdout_handle, stderr_handle);

    let exit_status = child.wait().await.map_err(|e| {
        let msg = format!("Failed to wait for bun process: {e}");
        emit_plugin_event(emitter, task_id, PluginInstallEventKind::Failed, &msg);
        msg
    })?;

    if exit_status.success() {
        Ok(())
    } else {
        let msg = format!(
            "bun add {spec} exited with code {}",
            exit_status.code().unwrap_or(-1)
        );
        emit_plugin_event(emitter, task_id, PluginInstallEventKind::Failed, &msg);
        Err(msg)
    }
}

/// Every `packages/<name>@<version-or-tag>` directory belonging to one package.
///
/// Scanned rather than derived from the declared spec, because uninstall has to
/// clean up copies left by earlier specs too (a pinned `foo@1.2.3` and the
/// `foo@latest` it was pinned from). Scoped names nest: `@scope/name@1.0.0`
/// goes through `Path::join` the same way Node's `path.join` does, landing at
/// `packages/@scope/name@1.0.0`.
fn package_dirs_for(cache_dir: &Path, name: &str) -> Vec<PathBuf> {
    let packages = cache_dir.join("packages");
    let (parent, prefix) = match name.split_once('/') {
        Some((scope, bare)) if name.starts_with('@') => {
            (packages.join(scope), format!("{bare}@"))
        }
        _ => (packages, format!("{name}@")),
    };
    let prefix = sanitize_spec(&prefix);
    let Ok(entries) = std::fs::read_dir(&parent) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(prefix.as_str())
        })
        .map(|e| e.path())
        .collect()
}

/// Uninstall a single plugin: remove from opencode.json, then delete it from
/// both cache layouts.
pub async fn uninstall_plugin(name: String) -> Result<PluginCheckSummary, String> {
    let _guard = PLUGIN_OP_LOCK
        .try_lock()
        .map_err(|_| "Another plugin operation is in progress".to_string())?;

    if is_protected_package(&name) {
        return Err(format!(
            "Cannot uninstall {name}: it is an internal opencode package"
        ));
    }

    let config_path = opencode_config_path()
        .ok_or_else(|| "Cannot determine opencode config directory".to_string())?;
    let cache_dir = opencode_cache_dir()
        .ok_or_else(|| "Cannot determine opencode cache directory".to_string())?;

    // Step 1: Remove from opencode.json if declared
    if config_path.exists() {
        let _ = atomic_rewrite_opencode_json(&config_path, |doc| {
            if let Some(arr) = doc
                .as_object_mut()
                .and_then(|obj| obj.get_mut("plugin"))
                .and_then(|v| v.as_array_mut())
            {
                arr.retain(|item| {
                    if let Some(spec) = item.as_str() {
                        match parse_plugin_spec(spec) {
                            Some((parsed_name, _)) => parsed_name != name,
                            None => true,
                        }
                    } else {
                        true
                    }
                });
            }
            Ok(())
        });
    }

    // Step 2: drop the modern per-package directories. Deleting the directory
    // IS the uninstall there — opencode's hit test is a bare existence check
    // on it, so a copy left behind would keep loading.
    for dir in package_dirs_for(&cache_dir, &name) {
        if let Err(e) = fs::remove_dir_all(&dir) {
            return Err(format!("Failed to remove {}: {e}", dir.display()));
        }
    }

    // Step 3: and the legacy flat layout, which older installs (including
    // codeg's own, before this) wrote into.
    let bun = resolve_bun_binary()?;
    let output = crate::process::tokio_command(&bun)
        .arg("remove")
        .arg(&name)
        .current_dir(&cache_dir)
        .output()
        .await
        .map_err(|e| format!("Failed to run bun remove: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("not found") {
            return Err(format!("bun remove failed: {stderr}"));
        }
    }

    // Return fresh summary
    check_opencode_plugins(None)
}

/// Parse a plugin spec string from opencode.json `plugin[]` into (package_name, full_spec).
///
/// Examples:
/// - `"foo"` → `Some(("foo", "foo"))`
/// - `"foo@latest"` → `Some(("foo", "foo@latest"))`
/// - `"foo@1.2.3"` → `Some(("foo", "foo@1.2.3"))`
/// - `"@scope/name"` → `Some(("@scope/name", "@scope/name"))`
/// - `"@scope/name@1.2.3"` → `Some(("@scope/name", "@scope/name@1.2.3"))`
/// - `""` → `None`
pub fn parse_plugin_spec(spec: &str) -> Option<(String, String)> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }

    let full_spec = spec.to_string();

    if spec.starts_with('@') {
        // Scoped package: @scope/name or @scope/name@version
        let without_at = spec.strip_prefix('@')?;
        let slash_pos = without_at.find('/')?;
        let after_slash = &without_at[slash_pos + 1..];
        // Look for @ that separates name from version
        if let Some(version_at) = after_slash.find('@') {
            let name = &spec[..1 + slash_pos + 1 + version_at]; // @scope/name
            Some((name.to_string(), full_spec))
        } else {
            // No version part
            Some((spec.to_string(), full_spec))
        }
    } else {
        // Unscoped: name or name@version
        if let Some(at_pos) = spec.find('@') {
            let name = &spec[..at_pos];
            if name.is_empty() {
                return None; // bare "@" is invalid
            }
            Some((name.to_string(), full_spec))
        } else {
            Some((spec.to_string(), full_spec))
        }
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    /// The directory key opencode derives. Getting this wrong fails silently —
    /// codeg would report "installed" for a directory opencode never reads.
    #[test]
    fn effective_spec_matches_upstream_resolve_plugin_target() {
        // Bare name → `<name>@latest`.
        assert_eq!(effective_spec("foo", "foo"), "foo@latest");
        assert_eq!(
            effective_spec("@scope/foo", "@scope/foo"),
            "@scope/foo@latest"
        );
        // Already versioned/tagged → used verbatim.
        assert_eq!(effective_spec("foo@1.2.3", "foo"), "foo@1.2.3");
        assert_eq!(effective_spec("foo@latest", "foo"), "foo@latest");
        assert_eq!(
            effective_spec("@scope/foo@1.2.3", "@scope/foo"),
            "@scope/foo@1.2.3"
        );
    }

    /// Upstream gates its sanitizer on `process.platform === "win32"`, so the
    /// non-Windows form has to stay the identity or the paths diverge.
    #[test]
    fn sanitize_is_identity_off_windows() {
        let spec = "foo@1.2.3";
        assert_eq!(sanitize_spec(spec), spec);
        if cfg!(windows) {
            assert_eq!(sanitize_spec("npm:foo@1.0.0"), "npm_foo@1.0.0");
        } else {
            assert_eq!(sanitize_spec("npm:foo@1.0.0"), "npm:foo@1.0.0");
        }
    }

    #[test]
    fn package_dir_is_cache_packages_effective_spec() {
        let cache = Path::new("/cache/opencode");
        assert_eq!(
            plugin_package_dir(cache, "foo@latest"),
            Path::new("/cache/opencode/packages/foo@latest")
        );
        // Scoped names nest, exactly as Node's `path.join` makes them nest.
        assert_eq!(
            plugin_package_dir(cache, "@scope/foo@1.0.0"),
            Path::new("/cache/opencode/packages/@scope/foo@1.0.0")
        );
    }

    #[test]
    fn path_specs_are_recognized_and_left_out_of_the_package_cache() {
        for spec in ["./local", "/abs/local", "file:///x", "https://x/y"] {
            assert!(is_path_spec(spec), "{spec} must be a path spec");
        }
        for spec in ["foo", "foo@1.0.0", "@scope/foo"] {
            assert!(!is_path_spec(spec), "{spec} must not be a path spec");
        }
    }

    /// The three-state detection contract: modern-only, legacy-only, both.
    #[test]
    fn legacy_only_is_needs_migration_not_installed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cache = tmp.path();
        let name = "oh-my-opencode-slim";
        let declared = name;
        let effective = effective_spec(declared, name);

        let modern = modern_pkg_json(cache, &effective, name);
        let legacy = legacy_pkg_json(cache, name);

        // Legacy only.
        std::fs::create_dir_all(legacy.parent().expect("parent")).expect("mkdir");
        std::fs::write(&legacy, br#"{"version":"1.0.0"}"#).expect("write");
        assert!(!modern.exists());
        assert_eq!(read_pkg_version(&legacy).as_deref(), Some("1.0.0"));

        // Modern present too.
        std::fs::create_dir_all(modern.parent().expect("parent")).expect("mkdir");
        std::fs::write(&modern, br#"{"version":"2.0.0"}"#).expect("write");
        assert_eq!(read_pkg_version(&modern).as_deref(), Some("2.0.0"));
    }

    #[test]
    fn package_dirs_for_finds_every_version_of_one_package() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cache = tmp.path();
        for spec in ["foo@latest", "foo@1.0.0", "foobar@1.0.0"] {
            std::fs::create_dir_all(plugin_package_dir(cache, spec)).expect("mkdir");
        }
        let mut found: Vec<String> = package_dirs_for(cache, "foo")
            .into_iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        found.sort();
        // `foobar` must NOT be swept up by a `foo` prefix — the `@` in the
        // prefix is what keeps them apart.
        assert_eq!(found, vec!["foo@1.0.0", "foo@latest"]);
    }

    #[test]
    fn package_dirs_for_handles_scoped_names() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cache = tmp.path();
        std::fs::create_dir_all(plugin_package_dir(cache, "@scope/foo@1.0.0")).expect("mkdir");
        let found = package_dirs_for(cache, "@scope/foo");
        assert_eq!(found.len(), 1, "scoped package dir must be found");
    }
}
