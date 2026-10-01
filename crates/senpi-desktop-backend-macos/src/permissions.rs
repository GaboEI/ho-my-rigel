//! Actionable TCC refusals. Probes never call this module; denied actions do.

use std::sync::OnceLock;

use senpi_desktop_core::error::{DesktopError, PermissionDeniedData, TccPermission};

const LAUNCHER: &str = "the app that launched OmO (for a terminal launch, that terminal app)";

fn settings_url(permission: TccPermission) -> &'static str {
    match permission {
        TccPermission::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
        TccPermission::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
    }
}

fn host_app_name() -> String {
    launcher_name(std::env::var("SENPI_DESKTOP_HOST_APP").ok())
}

fn launcher_name(value: Option<String>) -> String {
    value.filter(|app| !app.trim().is_empty()).unwrap_or_else(|| LAUNCHER.to_owned())
}

#[derive(Default)]
struct Settings {
    screen_recording: OnceLock<bool>,
    accessibility: OnceLock<bool>,
}

impl Settings {
    fn open_settings_once(&self, permission: TccPermission, opener: impl FnOnce(&str) -> bool) -> bool {
        let opened = match permission {
            TccPermission::ScreenRecording => &self.screen_recording,
            TccPermission::Accessibility => &self.accessibility,
        };
        *opened.get_or_init(|| opener(settings_url(permission)))
    }
}

static SETTINGS: Settings = Settings {
    screen_recording: OnceLock::new(),
    accessibility: OnceLock::new(),
};

#[cfg(not(test))]
fn open_settings(url: &str) -> bool {
    match std::process::Command::new("/usr/bin/open").arg(url).status() {
        Ok(status) => status.success(),
        Err(error) => {
            eprintln!("cannot open macOS privacy settings: {error}");
            false
        }
    }
}

// Unit tests simulate denied capture without touching the test runner's desktop.
#[cfg(test)]
fn open_settings(_: &str) -> bool {
    true
}

pub(crate) fn permission_denied(permission: TccPermission) -> DesktopError {
    let opened = SETTINGS.open_settings_once(permission, open_settings);
    denial(permission, host_app_name(), opened)
}

fn denial(permission: TccPermission, app: String, opened: bool) -> DesktopError {
    denial_with_identity(permission, app, opened, crate::responsible::current)
}

fn denial_with_identity(
    permission: TccPermission,
    app: String,
    opened: bool,
    lookup: impl FnOnce() -> Option<crate::responsible::ResponsibleProcess>,
) -> DesktopError {
    let pane = match permission {
        TccPermission::ScreenRecording => "Screen Recording",
        TccPermission::Accessibility => "Accessibility",
    };
    let url = settings_url(permission);
    let identity = crate::responsible::suffix_with(lookup);
    let opening = if opened { "has been opened" } else { "could not be opened automatically; open it" };
    let message = format!(
        "macOS {pane} is not granted for {app}. System Settings > Privacy & Security > {pane} \
         {opening} ({url}): enable \"{app}\", then fully quit and relaunch {app} before retrying. \
         (TCC identity: {identity})"
    );
    DesktopError::permission_denied_with(
        PermissionDeniedData {
            permission,
            settings_url: url.to_owned(),
            app,
            relaunch_required: true,
        },
        message,
    )
}

#[cfg(test)]
#[path = "permissions/identity_tests.rs"]
mod identity_tests;

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use super::*;

    #[test]
    fn opens_each_permission_once_even_after_repeated_denials() {
        let settings = Settings::default();
        let opened = RefCell::new(Vec::new());
        let opener = |url: &str| { opened.borrow_mut().push(url.to_owned()); true };
        for permission in [TccPermission::ScreenRecording, TccPermission::ScreenRecording,
            TccPermission::Accessibility, TccPermission::Accessibility] {
            assert!(settings.open_settings_once(permission, opener));
        }
        assert_eq!(*opened.borrow(), [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ]);
    }

    #[test]
    fn failed_open_is_not_retried_and_keeps_its_failure_state() {
        let settings = Settings::default();
        assert!(!settings.open_settings_once(TccPermission::Accessibility, |_| false));
        assert!(!settings.open_settings_once(TccPermission::Accessibility, |_| panic!("retry")));
    }

    #[test]
    fn absent_and_empty_host_names_use_the_launcher_phrase() {
        for value in [None, Some(String::new()), Some("  ".to_owned())] {
            assert_eq!(launcher_name(value), LAUNCHER);
        }
        assert_eq!(launcher_name(Some("QA App".to_owned())), "QA App");
        let error = denial(TccPermission::ScreenRecording, launcher_name(None), true);
        assert_eq!(error.permission.unwrap().app, LAUNCHER);
    }

    #[test]
    fn accessibility_error_carries_the_settings_contract() {
        let error = denial(TccPermission::Accessibility, "QA App".to_owned(), true);
        let data = error.permission.unwrap();
        assert_eq!(data.permission, TccPermission::Accessibility);
        assert_eq!(data.settings_url,
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        assert_eq!(data.app, "QA App");
        assert!(data.relaunch_required);
    }
}
