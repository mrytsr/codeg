//! Generative UI: the `generative_ui.enabled` switch and the `json-render`
//! skill it hands to agents.
//!
//! One switch, two halves:
//!   * the chat renders a ```spec fence in an assistant reply as a json-render
//!     card — frontend only, driven by this setting and its broadcast;
//!   * an agent learns that format from a skill Codeg ships, `json-render`
//!     (`genui/json-render/SKILL.md`, generated from the frontend's catalog).
//!
//! The skill reaches an agent the way the bundled skill packs do: a central
//! copy in the shared store (`~/.codeg/skills/json-render`), symlinked (or
//! junctioned) into the agent's own skill directory. What differs is when:
//!   * right before Codeg starts an agent ([`sync_skill_before_launch`]): with
//!     the switch on, the central copy is brought up to date and linked into
//!     that agent's preferred skill directory; with it off, a link of ours left
//!     there is taken back. Only agents someone actually starts are touched, so
//!     an agent that is not even installed never grows a skill directory, and
//!     a link that went missing is restored at the next launch;
//!   * the moment the switch goes off: our links leave every agent at once.
//!     The central copy stays, so a link of ours never dangles.
//!
//! **Ownership.** The central copy carries a marker file. A link is ours only
//! when it resolves to the central copy AND that copy is marked; a dangling
//! link cannot be attributed to anyone and is left alone. A `json-render`
//! directory in the central store WITHOUT the marker is the user's own skill
//! of that name, possibly already linked into agents. Codeg then does nothing
//! with it — no overwrite, no link, no cleanup — and the settings page asks
//! the user to rename theirs. Taking it over instead would leave the user's
//! existing links pointing at Codeg's content, and the next switch-off would
//! delete them as ours.
//!
//! **One lock.** The value the launch path acts on lives behind the mutex a
//! settings write holds across its write, cleanup and broadcast, and a launch
//! holds it across its own filesystem work. Otherwise a launch that read "on"
//! just before a switch-off could put a link back right after the cleanup.
//! The filesystem half owns the lock, not the async caller: a launch or save
//! whose caller goes away midway (an HTTP client hanging up) still holds it
//! until its blocking work is done.
//!
//! **Where we linked.** The central copy also keeps a list of the links made
//! from it, so a switch-off reaches a directory an agent no longer declares —
//! a custom agent that moved its skill directory, a changed `CODEX_HOME`. The
//! list only says where to look; what is removed must still be provably ours.
//!
//! Not a portable (config-sync) key: the switch rewrites this machine's agent
//! skill directories.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::acp::types::AgentSkillScope;
use crate::app_error::AppCommandError;
use crate::commands::acp::{remove_skill_entry, scoped_skill_dirs, skill_storage_spec};
use crate::commands::experts::{
    central_experts_dir, classify_link, create_link_raw, ExpertLinkState,
};
use crate::db::service::app_metadata_service;
use crate::models::agent::AgentType;
use crate::web::event_bridge::{emit_event, EventEmitter, GENERATIVE_UI_SETTINGS_CHANGED_EVENT};

pub const KEY_GENERATIVE_UI_ENABLED: &str = "generative_ui.enabled";

/// The skill's directory name everywhere, and what the user types
/// (`/json-render`, `$json-render` in Codex).
pub(crate) const SKILL_ID: &str = "json-render";

/// Generated from the frontend catalog (`src/lib/json-render/skill.ts`);
/// `skill.test.ts` keeps the two equal.
const SKILL_MD: &str = include_str!("../../genui/json-render/SKILL.md");

/// Written into the central copy before anything else: says Codeg made it.
pub(crate) const MARKER_FILE: &str = ".codeg-managed";
const MARKER_TEXT: &str = "Codeg installs this skill while generative UI is on \
(Settings > Skill Packs > UI) and rewrites it when it changes. Edits made here are lost.\n";

/// Also in the central copy: every link made from it that may still exist,
/// one path per line.
const LINKS_FILE: &str = ".codeg-links";

/// Off by default: turning it on puts a skill in front of every agent Codeg
/// starts.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GenerativeUiSettings {
    pub enabled: bool,
    /// Reported, never saved: the central store holds a `json-render` skill
    /// Codeg did not write, so Codeg leaves the skill alone until the user
    /// renames theirs (see the module doc).
    #[serde(default)]
    pub skill_conflict: bool,
    /// Reported by a switch-off, never saved: links of ours it could not
    /// remove, as `path: error`. Each later launch of those agents retries.
    #[serde(default)]
    pub unlink_failures: Vec<String>,
}

// ─── Where things live ──────────────────────────────────────────────────

/// Where the central copy goes and where each agent looks for skills. The
/// real one resolves both on every call, from the environment Codeg runs in;
/// tests point both at temporary directories.
#[derive(Debug, Clone)]
enum SkillHome {
    User,
    #[cfg(test)]
    Fixed {
        central_root: PathBuf,
        agents: Vec<(AgentType, Vec<PathBuf>)>,
        /// Holds a launch inside its filesystem half: it reports that it got
        /// there, then waits to be let go.
        launch_gate: Option<Arc<LaunchGate>>,
    },
}

#[cfg(test)]
#[derive(Debug)]
struct LaunchGate {
    reached: std::sync::Mutex<std::sync::mpsc::Sender<()>>,
    go: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

impl SkillHome {
    fn central_copy(&self) -> PathBuf {
        let root = match self {
            SkillHome::User => central_experts_dir(),
            #[cfg(test)]
            SkillHome::Fixed { central_root, .. } => central_root.clone(),
        };
        root.join(SKILL_ID)
    }

    /// An agent's global skill directories, the preferred one first. Empty for
    /// an agent without a skill store.
    fn agent_dirs(&self, agent: AgentType) -> Vec<PathBuf> {
        match self {
            SkillHome::User => {
                scoped_skill_dirs(agent, AgentSkillScope::Global, None).unwrap_or_default()
            }
            #[cfg(test)]
            SkillHome::Fixed {
                agents,
                launch_gate,
                ..
            } => {
                if let Some(gate) = launch_gate {
                    let _ = gate.reached.lock().unwrap().send(());
                    let _ = gate.go.lock().unwrap().recv();
                }
                agents
                    .iter()
                    .find(|(a, _)| *a == agent)
                    .map(|(_, dirs)| dirs.clone())
                    .unwrap_or_default()
            }
        }
    }

    /// Every global skill directory of every agent that has one, each once —
    /// several agents share `~/.agents/skills`.
    fn every_agent_dir(&self) -> Vec<PathBuf> {
        let dirs: Vec<PathBuf> = match self {
            SkillHome::User => crate::acp::registry::all_acp_agents()
                .into_iter()
                .filter(|a| skill_storage_spec(*a).is_some())
                .flat_map(|agent| self.agent_dirs(agent))
                .collect(),
            #[cfg(test)]
            SkillHome::Fixed { agents, .. } => agents
                .iter()
                .flat_map(|(_, dirs)| dirs.iter().cloned())
                .collect(),
        };
        let mut seen = BTreeSet::new();
        dirs.into_iter()
            .filter(|dir| seen.insert(dir.clone()))
            .collect()
    }
}

// ─── The central copy ───────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CentralCopy {
    Absent,
    /// A real directory carrying our marker.
    Ours,
    /// Anything else under that name: the user's own skill.
    Foreign,
}

fn central_copy_state(dir: &Path) -> io::Result<CentralCopy> {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.is_dir() && dir.join(MARKER_FILE).is_file() => Ok(CentralCopy::Ours),
        Ok(_) => Ok(CentralCopy::Foreign),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(CentralCopy::Absent),
        Err(err) => Err(err),
    }
}

fn is_foreign(dir: &Path) -> bool {
    matches!(central_copy_state(dir), Ok(CentralCopy::Foreign))
}

/// Create the central copy on first use and rewrite its `SKILL.md` whenever
/// it differs from the bundled one. Refuses to touch a copy that is not ours.
fn ensure_central_copy(dir: &Path) -> io::Result<()> {
    match central_copy_state(dir)? {
        CentralCopy::Foreign => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} is not Codeg's; leaving it alone", dir.display()),
            ))
        }
        CentralCopy::Absent => {
            if let Some(parent) = dir.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::create_dir(dir)?;
            // The marker before the skill: a copy cut short before its
            // SKILL.md is still recognisably ours and gets finished next
            // time, while an unmarked SKILL.md would pass for the user's own.
            fs::write(dir.join(MARKER_FILE), MARKER_TEXT)?;
        }
        CentralCopy::Ours => {}
    }
    let skill_md = dir.join("SKILL.md");
    if fs::read(&skill_md).ok().as_deref() != Some(SKILL_MD.as_bytes()) {
        // Through a rename, so an agent reading the skill never sees half.
        let partial = dir.join(".SKILL.md.partial");
        fs::write(&partial, SKILL_MD)?;
        if let Err(err) = fs::rename(&partial, &skill_md) {
            let _ = fs::remove_file(&partial);
            return Err(err);
        }
    }
    Ok(())
}

// ─── Links ──────────────────────────────────────────────────────────────

/// The recorded links. A list that is missing is empty; one that cannot be
/// read is an error, never an empty list — rewriting it from nothing would
/// forget links that still exist.
fn recorded_links(central: &Path) -> io::Result<Vec<PathBuf>> {
    match fs::read_to_string(central.join(LINKS_FILE)) {
        Ok(list) => Ok(list
            .lines()
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err),
    }
}

/// Through a rename, so an interrupted write never loses the list.
fn write_recorded_links(central: &Path, links: &[PathBuf]) -> io::Result<()> {
    let list: String = links
        .iter()
        .map(|link| format!("{}\n", link.display()))
        .collect();
    let partial = central.join(".codeg-links.partial");
    fs::write(&partial, list)?;
    fs::rename(&partial, central.join(LINKS_FILE)).inspect_err(|_| {
        let _ = fs::remove_file(&partial);
    })
}

fn remember_link(central: &Path, link: &Path) -> io::Result<()> {
    let mut links = recorded_links(central)?;
    if links.iter().any(|known| known == link) {
        return Ok(());
    }
    links.push(link.to_path_buf());
    write_recorded_links(central, &links)
}

/// Link the central copy into `dir`, an agent's preferred skill directory.
/// Whatever already sits there under our name stays, unless it is our link.
fn link_into(central: &Path, dir: &Path) -> io::Result<()> {
    let link = dir.join(SKILL_ID);
    // Decided before creating anything, never by trying and reading the
    // error: on Windows `create_link_raw` falls back to copying the whole
    // directory when it cannot make a junction, which would write over a
    // directory of the same name.
    match classify_link(&link, central) {
        ExpertLinkState::NotLinked => {
            // Recorded before it exists: a link that could not be recorded
            // is not made at all, so none can go unfound later.
            remember_link(central, &link)?;
            fs::create_dir_all(dir)?;
            create_link_raw(central, &link)?;
            tracing::info!("[GenerativeUI] linked {}", link.display());
        }
        ExpertLinkState::LinkedToCodeg => remember_link(central, &link)?,
        other => tracing::info!(
            "[GenerativeUI] {} is taken ({other:?}); the user's own wins",
            link.display()
        ),
    }
    Ok(())
}

/// Take our links out of `dirs` and out of every place a link was recorded.
/// Only a link resolving to the central copy, while that copy is ours, counts
/// as ours. Returns what failed; those stay recorded for the next attempt.
fn unlink_from(central: &Path, dirs: &[PathBuf]) -> Vec<(PathBuf, io::Error)> {
    let mut failures = Vec::new();
    if !matches!(central_copy_state(central), Ok(CentralCopy::Ours)) {
        // Nothing of ours can exist: without our marked copy there is no
        // target a link of ours could resolve to.
        return failures;
    }
    // Without the list, every place an agent declares is one we may have
    // linked, and the list itself stays as it is.
    let recorded = match recorded_links(central) {
        Ok(links) => Some(links),
        Err(err) => {
            failures.push((central.join(LINKS_FILE), err));
            None
        }
    };
    let mut candidates: Vec<PathBuf> = dirs.iter().map(|dir| dir.join(SKILL_ID)).collect();
    for link in recorded.iter().flatten() {
        if !candidates.contains(link) {
            candidates.push(link.clone());
        }
    }
    for link in candidates {
        // A place we linked that cannot even be looked at (its directory's
        // permissions changed) may still hold our link: say so, and keep it
        // on the list. Elsewhere it only means no link of ours is there.
        if let Err(err) = fs::symlink_metadata(&link) {
            let maybe_ours = recorded.as_ref().is_none_or(|known| known.contains(&link));
            if err.kind() != io::ErrorKind::NotFound && maybe_ours {
                failures.push((link, err));
            }
            continue;
        }
        if classify_link(&link, central) != ExpertLinkState::LinkedToCodeg {
            continue;
        }
        match remove_skill_entry(&link) {
            Ok(()) => tracing::info!("[GenerativeUI] unlinked {}", link.display()),
            Err(err) => failures.push((link, err)),
        }
    }
    if let Some(recorded) = recorded {
        let left: Vec<PathBuf> = failures.iter().map(|(link, _)| link.clone()).collect();
        if left != recorded {
            if let Err(err) = write_recorded_links(central, &left) {
                tracing::warn!("[GenerativeUI] could not update the link list: {err}");
            }
        }
    }
    failures
}

/// The switch on, at an agent's launch: an up-to-date central copy, linked
/// into the agent's preferred skill directory. Quietly nothing while the name
/// belongs to a skill of the user's — the settings page already says so.
fn install_for(central: &Path, dirs: &[PathBuf]) -> io::Result<()> {
    let Some(preferred) = dirs.first() else {
        return Ok(());
    };
    if is_foreign(central) {
        return Ok(());
    }
    ensure_central_copy(central)?;
    link_into(central, preferred)
}

// ─── The switch ─────────────────────────────────────────────────────────

struct GenerativeUi {
    /// The switch as the launch path sees it. `None` until the stored value
    /// is loaded at startup: a launch before that — or in a test that never
    /// loads it — leaves every skill directory alone.
    switch: Arc<Mutex<Option<bool>>>,
    home: SkillHome,
}

static GENERATIVE_UI: LazyLock<GenerativeUi> = LazyLock::new(|| GenerativeUi::new(SkillHome::User));

impl GenerativeUi {
    fn new(home: SkillHome) -> Self {
        Self {
            switch: Arc::new(Mutex::new(None)),
            home,
        }
    }

    async fn load(&self, conn: &DatabaseConnection) -> GenerativeUiSettings {
        let enabled = load_enabled(conn).await;
        let home = self.home.clone();
        let skill_conflict = tokio::task::spawn_blocking(move || is_foreign(&home.central_copy()))
            .await
            .unwrap_or(false);
        GenerativeUiSettings {
            enabled,
            skill_conflict,
            unlink_failures: Vec::new(),
        }
    }

    async fn apply_persisted(&self, conn: &DatabaseConnection) {
        let enabled = load_enabled(conn).await;
        *self.switch.lock().await = Some(enabled);
    }

    async fn set(
        &self,
        conn: &DatabaseConnection,
        emitter: &EventEmitter,
        desired: GenerativeUiSettings,
    ) -> Result<GenerativeUiSettings, AppCommandError> {
        let mut switch = self.switch.clone().lock_owned().await;
        app_metadata_service::upsert_value(
            conn,
            KEY_GENERATIVE_UI_ENABLED,
            &desired.enabled.to_string(),
        )
        .await
        .map_err(AppCommandError::from)?;
        *switch = Some(desired.enabled);

        let enabled = desired.enabled;
        let home = self.home.clone();
        let emitter = emitter.clone();
        tokio::task::spawn_blocking(move || {
            let _switch = switch;
            let central = home.central_copy();
            let mut unlink_failures = Vec::new();
            if enabled {
                // Written now rather than at the first launch, so a skill of
                // the user's in the way shows up on the settings page at once.
                // Nothing is linked until an agent starts.
                if !is_foreign(&central) {
                    if let Err(err) = ensure_central_copy(&central) {
                        tracing::warn!("[GenerativeUI] central copy: {err}");
                    }
                }
            } else {
                for (link, err) in unlink_from(&central, &home.every_agent_dir()) {
                    tracing::warn!("[GenerativeUI] could not unlink {}: {err}", link.display());
                    unlink_failures.push(format!("{}: {err}", link.display()));
                }
            }
            let saved = GenerativeUiSettings {
                enabled,
                skill_conflict: is_foreign(&central),
                unlink_failures,
            };
            emit_event(&emitter, GENERATIVE_UI_SETTINGS_CHANGED_EVENT, &saved);
            saved
        })
        .await
        .map_err(|err| AppCommandError::task_execution_failed(err.to_string()))
    }

    async fn sync_before_launch(&self, agent: AgentType) {
        let switch = self.switch.clone().lock_owned().await;
        let Some(enabled) = *switch else {
            return;
        };
        let home = self.home.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _switch = switch;
            let dirs = home.agent_dirs(agent);
            let central = home.central_copy();
            if enabled {
                install_for(&central, &dirs)
            } else {
                match unlink_from(&central, &dirs).into_iter().next() {
                    Some((link, err)) => Err(io::Error::new(
                        err.kind(),
                        format!("unlink {}: {err}", link.display()),
                    )),
                    None => Ok(()),
                }
            }
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => tracing::warn!("[GenerativeUI] skill sync for {agent:?}: {err}"),
            Err(err) => tracing::warn!("[GenerativeUI] skill sync for {agent:?} panicked: {err}"),
        }
    }
}

async fn load_enabled(conn: &DatabaseConnection) -> bool {
    match app_metadata_service::get_value(conn, KEY_GENERATIVE_UI_ENABLED).await {
        Ok(Some(raw)) => raw.parse::<bool>().unwrap_or(false),
        _ => false,
    }
}

// ─── Entry points ───────────────────────────────────────────────────────

/// The stored switch, plus whether a skill of the user's blocks ours.
pub async fn load_generative_ui_settings(conn: &DatabaseConnection) -> GenerativeUiSettings {
    GENERATIVE_UI.load(conn).await
}

/// Load the stored switch for the launch path. Run once at startup, before
/// any agent can start.
pub async fn apply_persisted_generative_ui_config(conn: &DatabaseConnection) {
    GENERATIVE_UI.apply_persisted(conn).await;
}

/// Persist + apply + broadcast, shared by the Tauri command and the HTTP
/// handler. Switching off removes our links from every agent before the
/// broadcast goes out; switching on links nothing until an agent starts.
///
/// The broadcast is what moves the chat: the settings UI runs in a separate
/// window, so open conversations learn that cards are on or off only from it.
pub async fn set_generative_ui_settings_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    desired: GenerativeUiSettings,
) -> Result<GenerativeUiSettings, AppCommandError> {
    GENERATIVE_UI.set(conn, emitter, desired).await
}

/// Called right before an agent process starts: link the skill in (switch
/// on) or take our link back (switch off). Never fails the launch — a skill
/// that could not be synced is logged, and the session starts without it.
pub async fn sync_skill_before_launch(agent: AgentType) {
    GENERATIVE_UI.sync_before_launch(agent).await;
}

/// The central-store id this module owns, for the custom-skills pack to keep
/// out of its list — only while the copy there is Codeg's. A `json-render`
/// the user made stays a custom skill they can see, edit and rename.
pub(crate) fn reserved_skill_ids() -> Vec<String> {
    reserved_ids_in(&SkillHome::User.central_copy())
}

fn reserved_ids_in(central: &Path) -> Vec<String> {
    match central_copy_state(central) {
        Ok(CentralCopy::Ours) => vec![SKILL_ID.to_string()],
        _ => Vec::new(),
    }
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_generative_ui_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<GenerativeUiSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_generative_ui_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_generative_ui_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    settings: GenerativeUiSettings,
) -> Result<GenerativeUiSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_generative_ui_settings_core(&db.conn, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::event_bridge::WebEventBroadcaster;
    use std::sync::Arc;

    /// A home of temporary directories: the central store and one skill
    /// directory per agent (Codex's has a second, shared one, like the real
    /// `~/.agents/skills`).
    struct Fixture {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        ui: GenerativeUi,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp = tempfile::tempdir().expect("tempdir");
            let root = tmp.path().to_path_buf();
            let agents = vec![
                (AgentType::ClaudeCode, vec![root.join("claude/skills")]),
                (
                    AgentType::Codex,
                    vec![root.join("codex/skills"), root.join("agents/skills")],
                ),
                (AgentType::Gemini, vec![root.join("agents/skills")]),
            ];
            let home = SkillHome::Fixed {
                central_root: root.join("central"),
                agents,
                launch_gate: None,
            };
            Self {
                _tmp: tmp,
                root,
                ui: GenerativeUi::new(home),
            }
        }

        /// The same home, with launches held at a gate: the first channel
        /// hears when one is inside its filesystem half, and a send on the
        /// second lets it go on.
        fn with_launch_gate() -> (
            Self,
            std::sync::mpsc::Receiver<()>,
            std::sync::mpsc::Sender<()>,
        ) {
            let (reached_tx, reached_rx) = std::sync::mpsc::channel();
            let (go_tx, go_rx) = std::sync::mpsc::channel();
            let mut fx = Self::new();
            if let SkillHome::Fixed { launch_gate, .. } = &mut fx.ui.home {
                *launch_gate = Some(Arc::new(LaunchGate {
                    reached: std::sync::Mutex::new(reached_tx),
                    go: std::sync::Mutex::new(go_rx),
                }));
            }
            (fx, reached_rx, go_tx)
        }

        fn central(&self) -> PathBuf {
            self.ui.home.central_copy()
        }

        fn link(&self, agent_dir: &str) -> PathBuf {
            self.root.join(agent_dir).join(SKILL_ID)
        }

        fn is_our_link(&self, agent_dir: &str) -> bool {
            classify_link(&self.link(agent_dir), &self.central()) == ExpertLinkState::LinkedToCodeg
        }

        async fn set(&self, db: &crate::db::AppDatabase, enabled: bool) -> GenerativeUiSettings {
            set_on(&self.ui, db, enabled).await
        }

        /// A directory standing where the central copy goes, made by the
        /// user (no marker), with its own content.
        fn plant_users_central_skill(&self) {
            fs::create_dir_all(self.central()).unwrap();
            fs::write(self.central().join("SKILL.md"), "mine\n").unwrap();
        }
    }

    async fn set_on(
        ui: &GenerativeUi,
        db: &crate::db::AppDatabase,
        enabled: bool,
    ) -> GenerativeUiSettings {
        ui.set(
            &db.conn,
            &EventEmitter::Noop,
            GenerativeUiSettings {
                enabled,
                ..Default::default()
            },
        )
        .await
        .expect("save")
    }

    fn exists(path: &Path) -> bool {
        fs::symlink_metadata(path).is_ok()
    }

    #[test]
    fn off_until_someone_turns_it_on() {
        assert!(!GenerativeUiSettings::default().enabled);
    }

    #[test]
    fn the_bundled_skill_is_named_after_its_directory() {
        assert!(SKILL_MD.starts_with("---\nname: json-render\ndescription: "));
    }

    /// Every platform ships the bytes `skill.ts` generates. A Windows checkout
    /// converts text to CRLF by default (`core.autocrlf`), which `include_str!`
    /// would compile in as is; `.gitattributes` pins `genui/` to LF.
    #[test]
    fn the_bundled_skill_has_lf_line_endings() {
        assert!(
            !SKILL_MD.contains('\r'),
            "genui/json-render/SKILL.md was checked out with CRLF; check the \
             `eol=lf` rule for it in .gitattributes"
        );
    }

    #[tokio::test]
    async fn save_persists_and_broadcasts() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        let saved = fx
            .ui
            .set(
                &db.conn,
                &emitter,
                GenerativeUiSettings {
                    enabled: true,
                    // Whatever a caller sends in these is not saved.
                    skill_conflict: true,
                    unlink_failures: vec!["x".into()],
                },
            )
            .await
            .unwrap();
        assert_eq!(
            saved,
            GenerativeUiSettings {
                enabled: true,
                ..Default::default()
            }
        );
        assert_eq!(fx.ui.load(&db.conn).await, saved);

        let evt = rx.try_recv().expect("a save broadcasts");
        assert_eq!(evt.channel, GENERATIVE_UI_SETTINGS_CHANGED_EVENT);
        assert_eq!(evt.payload["enabled"], true);
        assert_eq!(evt.payload["skill_conflict"], false);
    }

    #[tokio::test]
    async fn the_launch_path_acts_on_the_stored_value_once_loaded() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, KEY_GENERATIVE_UI_ENABLED, "true")
            .await
            .unwrap();

        // Not loaded yet: nothing is touched.
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert!(!exists(&fx.central()));
        assert!(!exists(&fx.link("claude/skills")));

        fx.ui.apply_persisted(&db.conn).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert!(fx.is_our_link("claude/skills"));
    }

    #[tokio::test]
    async fn turning_it_on_writes_the_central_copy_and_links_nothing() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;

        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            SKILL_MD
        );
        assert!(fx.central().join(MARKER_FILE).is_file());
        for dir in ["claude/skills", "codex/skills", "agents/skills"] {
            assert!(!exists(&fx.root.join(dir)), "{dir} must not be created");
        }
    }

    #[tokio::test]
    async fn a_launch_links_its_own_agent_once_into_the_preferred_dir() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;

        fx.ui.sync_before_launch(AgentType::Codex).await;
        assert!(fx.is_our_link("codex/skills"));
        assert!(!exists(&fx.link("agents/skills")), "only the preferred dir");
        assert!(
            !exists(&fx.link("claude/skills")),
            "only the launching agent"
        );

        // Again: still the one link.
        fx.ui.sync_before_launch(AgentType::Codex).await;
        assert!(fx.is_our_link("codex/skills"));
    }

    #[tokio::test]
    async fn a_launch_brings_an_outdated_central_copy_up_to_date() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        fs::write(fx.central().join("SKILL.md"), "an older version\n").unwrap();

        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            SKILL_MD
        );
    }

    #[tokio::test]
    async fn a_marker_without_a_skill_is_finished_rather_than_disowned() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        // What an install cut short between the marker and SKILL.md leaves.
        fs::create_dir_all(fx.central()).unwrap();
        fs::write(fx.central().join(MARKER_FILE), MARKER_TEXT).unwrap();

        let saved = fx.set(&db, true).await;
        assert!(!saved.skill_conflict);
        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            SKILL_MD
        );
    }

    #[tokio::test]
    async fn whatever_already_holds_the_name_in_an_agent_dir_stays() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        // The user's own `json-render` in Claude's skill dir.
        let theirs = fx.link("claude/skills");
        fs::create_dir_all(&theirs).unwrap();
        fs::write(theirs.join("SKILL.md"), "theirs\n").unwrap();

        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert_eq!(
            classify_link(&theirs, &fx.central()),
            ExpertLinkState::BlockedByRealDirectory
        );
        assert_eq!(
            fs::read_to_string(theirs.join("SKILL.md")).unwrap(),
            "theirs\n"
        );
    }

    #[tokio::test]
    async fn turning_it_off_takes_back_only_our_links_and_keeps_the_copy() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        fx.ui.sync_before_launch(AgentType::Codex).await;
        assert!(fx.is_our_link("claude/skills"));
        assert!(fx.is_our_link("codex/skills"));

        // Gemini's dir (shared with Codex's second one) holds a link to
        // somewhere else.
        let elsewhere = fx.root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(fx.root.join("agents/skills")).unwrap();
        create_link_raw(&elsewhere, &fx.link("agents/skills")).unwrap();

        fx.set(&db, false).await;
        assert!(!exists(&fx.link("claude/skills")));
        assert!(!exists(&fx.link("codex/skills")));
        assert_eq!(
            classify_link(&fx.link("agents/skills"), &elsewhere),
            ExpertLinkState::LinkedToCodeg,
            "a link to somewhere else is not ours"
        );
        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            SKILL_MD,
            "the central copy stays"
        );
    }

    #[tokio::test]
    async fn a_dangling_link_is_nobody_we_can_name() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        let gone = fx.root.join("gone");
        fs::create_dir_all(&gone).unwrap();
        fs::create_dir_all(fx.root.join("claude/skills")).unwrap();
        create_link_raw(&gone, &fx.link("claude/skills")).unwrap();
        fs::remove_dir_all(&gone).unwrap();
        assert_eq!(
            classify_link(&fx.link("claude/skills"), &fx.central()),
            ExpertLinkState::Broken
        );

        fx.set(&db, false).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert!(exists(&fx.link("claude/skills")));
    }

    #[tokio::test]
    async fn a_launch_with_it_off_takes_back_a_link_of_ours() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        // Off without the cleanup reaching Claude's dir (say it failed).
        app_metadata_service::upsert_value(&db.conn, KEY_GENERATIVE_UI_ENABLED, "false")
            .await
            .unwrap();
        fx.ui.apply_persisted(&db.conn).await;
        assert!(fx.is_our_link("claude/skills"));

        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert!(!exists(&fx.link("claude/skills")));
    }

    #[tokio::test]
    async fn a_skill_of_the_users_under_the_name_is_never_taken_over() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.plant_users_central_skill();
        // ...which the user already linked into Claude.
        fs::create_dir_all(fx.root.join("claude/skills")).unwrap();
        create_link_raw(&fx.central(), &fx.link("claude/skills")).unwrap();

        let saved = fx.set(&db, true).await;
        assert!(saved.skill_conflict);
        assert!(fx.ui.load(&db.conn).await.skill_conflict);
        fx.ui.sync_before_launch(AgentType::Codex).await;
        assert!(!exists(&fx.link("codex/skills")), "not linked anywhere");

        fx.set(&db, false).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert_eq!(
            classify_link(&fx.link("claude/skills"), &fx.central()),
            ExpertLinkState::LinkedToCodeg,
            "their link to their skill survives"
        );
        assert_eq!(
            fs::read_to_string(fx.central().join("SKILL.md")).unwrap(),
            "mine\n"
        );
        assert!(!fx.central().join(MARKER_FILE).exists());
    }

    #[tokio::test]
    async fn no_link_survives_a_switch_off_racing_launches() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;

        let launches = async {
            for _ in 0..8 {
                fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
                tokio::task::yield_now().await;
            }
        };
        let switch_off = async {
            tokio::task::yield_now().await;
            fx.set(&db, false).await;
        };
        tokio::join!(launches, switch_off);
        assert!(!exists(&fx.link("claude/skills")));
    }

    /// The lock belongs to the filesystem half: a launch whose caller goes
    /// away after it started linking still finishes before a switch-off
    /// gets to clean up.
    #[tokio::test]
    async fn a_launch_abandoned_midway_cannot_outlive_a_switch_off() {
        let (fx, reached, go) = Fixture::with_launch_gate();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;

        // Its caller gives up once the launch is inside its filesystem half.
        let mut launch = Box::pin(fx.ui.sync_before_launch(AgentType::ClaudeCode));
        let inside = tokio::task::spawn_blocking(move || reached.recv());
        tokio::select! {
            _ = &mut launch => panic!("the launch cannot finish before it is let go"),
            got = inside => got.unwrap().unwrap(),
        }
        drop(launch);

        // The switch-off has to wait for the abandoned launch, which links
        // only once it is let go, after the switch-off asked for the lock.
        let let_go = async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            go.send(()).unwrap();
        };
        tokio::join!(fx.set(&db, false), let_go);
        // Room for an abandoned launch that did NOT hold the lock to link
        // after the switch-off; one that held it is long done.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!exists(&fx.link("claude/skills")));
    }

    /// A custom agent that moved its skill directory, or a changed
    /// `CODEX_HOME`: the old link is no longer under any directory an agent
    /// declares, and the switch-off still finds it.
    #[tokio::test]
    async fn a_link_where_an_agent_no_longer_looks_is_still_taken_back() {
        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert!(fx.is_our_link("claude/skills"));

        let moved = GenerativeUi::new(SkillHome::Fixed {
            central_root: fx.root.join("central"),
            agents: vec![(AgentType::ClaudeCode, vec![fx.root.join("moved/skills")])],
            launch_gate: None,
        });
        set_on(&moved, &db, false).await;
        assert!(!exists(&fx.link("claude/skills")));
    }

    /// A link that cannot be removed is reported to the caller, stays on the
    /// list, and is retried by the next launch of its agent.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_switch_off_reports_what_it_could_not_remove() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        let dir = fx.root.join("claude/skills");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(dir.join("probe"), "").is_ok() {
            // Running as root: permissions do not stop anything here.
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        let saved = fx.set(&db, false).await;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(saved.unlink_failures.len(), 1, "{saved:?}");
        assert!(saved.unlink_failures[0].contains("claude/skills/json-render"));
        assert_eq!(
            recorded_links(&fx.central()).unwrap(),
            vec![fx.link("claude/skills")]
        );

        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        assert!(!exists(&fx.link("claude/skills")));
        assert!(recorded_links(&fx.central()).unwrap().is_empty());
    }

    /// A recorded link whose directory can no longer be read is not
    /// forgotten as gone: the switch-off reports it and keeps it listed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_place_that_cannot_be_looked_at_is_reported_not_forgotten() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        let dir = fx.root.join("claude/skills");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::symlink_metadata(fx.link("claude/skills")).is_ok() {
            // Running as root: permissions do not stop anything here.
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        let saved = fx.set(&db, false).await;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(saved.unlink_failures.len(), 1, "{saved:?}");
        assert_eq!(
            recorded_links(&fx.central()).unwrap(),
            vec![fx.link("claude/skills")]
        );

        fx.ui.sync_before_launch(AgentType::Gemini).await;
        assert!(
            !exists(&fx.link("claude/skills")),
            "any later launch retries"
        );
    }

    /// No link is made that the list does not know about.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_link_that_cannot_be_recorded_is_not_made() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        let central = fx.central();
        fs::set_permissions(&central, fs::Permissions::from_mode(0o555)).unwrap();
        if fs::write(central.join("probe"), "").is_ok() {
            fs::set_permissions(&central, fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }

        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        fs::set_permissions(&central, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!exists(&fx.link("claude/skills")));
    }

    /// A list that cannot be read is never rewritten from nothing: no new
    /// link is made against it, and a switch-off reports it and leaves it.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreadable_link_list_is_kept_and_reported() {
        use std::os::unix::fs::PermissionsExt;

        let fx = Fixture::new();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        fx.set(&db, true).await;
        fx.ui.sync_before_launch(AgentType::ClaudeCode).await;
        let list = fx.central().join(LINKS_FILE);
        fs::set_permissions(&list, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_to_string(&list).is_ok() {
            // Running as root: permissions do not stop anything here.
            fs::set_permissions(&list, fs::Permissions::from_mode(0o644)).unwrap();
            return;
        }

        fx.ui.sync_before_launch(AgentType::Codex).await;
        assert!(!exists(&fx.link("codex/skills")), "not linked unrecorded");

        let saved = fx.set(&db, false).await;
        fs::set_permissions(&list, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            saved.unlink_failures.iter().any(|f| f.contains(LINKS_FILE)),
            "{saved:?}"
        );
        assert!(
            !exists(&fx.link("claude/skills")),
            "declared dirs still cleaned"
        );
        assert_eq!(
            recorded_links(&fx.central()).unwrap(),
            vec![fx.link("claude/skills")],
            "the list was left alone"
        );
    }

    #[test]
    fn only_our_marked_copy_reserves_the_name() {
        let tmp = tempfile::tempdir().unwrap();
        let central = tmp.path().join(SKILL_ID);
        assert!(reserved_ids_in(&central).is_empty(), "absent");

        fs::create_dir_all(&central).unwrap();
        fs::write(central.join("SKILL.md"), "mine\n").unwrap();
        assert!(reserved_ids_in(&central).is_empty(), "the user's own");

        fs::write(central.join(MARKER_FILE), MARKER_TEXT).unwrap();
        assert_eq!(reserved_ids_in(&central), vec![SKILL_ID.to_string()]);
    }
}
