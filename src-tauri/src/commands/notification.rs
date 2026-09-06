//! OS notifications, and the one affordance the platform gives us for
//! diagnosing them.
//!
//! Neither notification backend we use exposes a permission state on desktop:
//! `tauri-plugin-notification`'s desktop implementation hard-codes
//! `PermissionState::Granted` for both `permission_state()` and
//! `request_permission()`, and `mac-notification-sys` has no authorization API
//! at all. So the frontend cannot render "allowed / blocked" without inventing
//! it. What it CAN do is send a test notification and offer a shortcut to the
//! system pane that actually owns the decision — which is why both commands
//! here return real errors instead of best-effort silence.

#[cfg(feature = "tauri-runtime")]
use tauri::AppHandle;

#[cfg(feature = "tauri-runtime")]
use crate::app_error::{AppCommandError, AppErrorCode};

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn send_notification(
    #[allow(unused_variables)] app: AppHandle,
    title: String,
    body: String,
) -> Result<(), AppCommandError> {
    #[cfg(target_os = "macos")]
    {
        let app_id = if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            "app.codeg"
        };
        // Deliberately ignored. The bundle id can only be set once per process,
        // so every call after the first returns `ApplicationError::AlreadySet`
        // — an expected steady state, not a failure to report.
        let _ = mac_notification_sys::set_application(app_id);

        mac_notification_sys::Notification::default()
            .title(&title)
            .message(&body)
            .send()
            .map_err(|err| {
                AppCommandError::new(
                    AppErrorCode::ExternalCommandFailed,
                    "Failed to post the system notification",
                )
                .with_detail(err.to_string())
            })?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|err| {
                AppCommandError::new(
                    AppErrorCode::ExternalCommandFailed,
                    "Failed to post the system notification",
                )
                .with_detail(err.to_string())
            })?;
    }

    Ok(())
}

/// Candidate commands that open the OS pane governing notification permission,
/// most specific first. Every argument is a compile-time literal — no value
/// from the frontend reaches a shell — which is the reason this is a dedicated
/// command rather than a widened `opener` scope: `tauri-plugin-opener`'s
/// default scope only permits `http`/`https`/`mailto`/`tel`, and allowing
/// arbitrary custom schemes through it would open that door for every other
/// piece of renderer code too, including the markdown we render from agent
/// output.
#[cfg(feature = "tauri-runtime")]
fn system_notification_settings_candidates() -> &'static [(&'static str, &'static [&'static str])] {
    #[cfg(target_os = "macos")]
    {
        &[(
            "open",
            &["x-apple.systempreferences:com.apple.preference.notifications"],
        )]
    }
    #[cfg(target_os = "windows")]
    {
        // `start` is a `cmd` builtin, not an executable. The empty string is
        // the window title `start` would otherwise take the URL for.
        &[("cmd", &["/C", "start", "", "ms-settings:notifications"])]
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No cross-desktop standard exists, so try the two big desktops' panes
        // and give up honestly rather than opening something unrelated.
        &[
            ("gnome-control-center", &["notifications"]),
            ("systemsettings", &["kcm_notifications"]),
            ("kcmshell6", &["kcm_notifications"]),
            ("kcmshell5", &["kcm_notifications"]),
        ]
    }
}

/// How long to wait for a candidate to fail before treating it as "the pane is
/// open". `open` and `cmd /C start` hand off and exit within milliseconds, but
/// a Linux settings binary launched directly runs for as long as its window is
/// on screen — waiting for THAT to exit would leave the command pending until
/// the user closed System Settings.
#[cfg(feature = "tauri-runtime")]
const SETTINGS_LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_millis(700);

/// Open the OS pane where notification permission for this app is granted or
/// revoked.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_system_notification_settings() -> Result<(), AppCommandError> {
    let mut last_error: Option<String> = None;

    for (program, args) in system_notification_settings_candidates() {
        let child = crate::process::tokio_command(program).args(*args).spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(err) => {
                // The binary isn't installed — this desktop isn't the one this
                // candidate is for. Move on to the next.
                last_error = Some(format!("`{program}` could not be started: {err}"));
                continue;
            }
        };

        // Waiting (rather than detaching immediately) is what turns "this
        // desktop has no such pane" into a signal instead of a silent no-op:
        // `gnome-control-center` exits non-zero for a panel it doesn't know.
        // Dropping the `Child` on timeout leaves the process running; tokio's
        // orphan queue reaps it, so nothing becomes a zombie.
        match tokio::time::timeout(SETTINGS_LAUNCH_GRACE, child.wait()).await {
            Err(_elapsed) => return Ok(()),
            Ok(Ok(status)) if status.success() => return Ok(()),
            Ok(Ok(status)) => {
                last_error = Some(format!("`{program}` exited with {status}"));
            }
            Ok(Err(err)) => {
                last_error = Some(format!("`{program}` could not be waited on: {err}"));
            }
        }
    }

    Err(AppCommandError::new(
        AppErrorCode::DependencyMissing,
        "Could not open the system notification settings on this desktop",
    )
    .with_detail(last_error.unwrap_or_else(|| "no candidate command available".to_string())))
}
