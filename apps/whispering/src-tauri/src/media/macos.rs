//! macOS playback control, Wave 1: pause/resume Music and Spotify via
//! AppleScript. Temporary. Wave 4 replaces this with a MediaRemote link that
//! covers the whole system (browsers, web audio) and needs no Automation
//! permission.
//!
//! The session token is the app name (`"Music"` / `"Spotify"`); `resume` maps
//! it back to the player it names. AppleScript control of another app requires
//! one-time Automation consent; a denial is logged once it surfaces, never
//! blocks recording.

#[derive(Clone, Copy)]
enum MediaPlayer {
    Music,
    Spotify,
}

impl MediaPlayer {
    fn app_name(self) -> &'static str {
        match self {
            MediaPlayer::Music => "Music",
            MediaPlayer::Spotify => "Spotify",
        }
    }

    fn from_app_name(name: &str) -> Option<Self> {
        match name {
            "Music" => Some(MediaPlayer::Music),
            "Spotify" => Some(MediaPlayer::Spotify),
            _ => None,
        }
    }
}

/// `osascript` is blocking; run it off the recording hot path.
pub async fn pause_playing() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(pause_playing_sync)
        .await
        .map_err(|e| format!("Failed to pause playback: {e}"))?
}

pub async fn resume(sessions: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || resume_sync(sessions))
        .await
        .map_err(|e| format!("Failed to resume playback: {e}"))?
}

fn pause_playing_sync() -> Result<Vec<String>, String> {
    let mut paused = Vec::new();
    for player in [MediaPlayer::Music, MediaPlayer::Spotify] {
        match pause_player(player) {
            Ok(true) => paused.push(player.app_name().to_string()),
            Ok(false) => {}
            Err(message) => report_failure(player, &message),
        }
    }
    Ok(paused)
}

fn resume_sync(sessions: Vec<String>) -> Result<(), String> {
    for session in sessions {
        let Some(player) = MediaPlayer::from_app_name(&session) else {
            continue;
        };
        if let Err(message) = resume_player(player) {
            report_failure(player, &message);
        }
    }
    Ok(())
}

fn pause_player(player: MediaPlayer) -> Result<bool, String> {
    if !is_app_running(player.app_name()) {
        return Ok(false);
    }

    let script = format!(
        r#"
tell application "{app_name}"
	if player state is playing then
		pause
		return "paused"
	end if
end tell
return "idle"
"#,
        app_name = player.app_name()
    );

    run_osascript(&script).map(|output| output.trim() == "paused")
}

fn resume_player(player: MediaPlayer) -> Result<(), String> {
    // The FE only asks us to resume players we actually paused, so this guard
    // only fires when the user quit the app mid-recording. It still matters:
    // `tell application "X" to play` would cold-launch a quit app otherwise.
    if !is_app_running(player.app_name()) {
        return Ok(());
    }

    let script = format!(
        r#"
tell application "{app_name}" to play
"#,
        app_name = player.app_name()
    );

    run_osascript(&script).map(|_| ())
}

fn is_app_running(app_name: &str) -> bool {
    use std::process::Command;

    Command::new("/usr/bin/pgrep")
        .args(["-x", app_name])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn run_osascript(script: &str) -> Result<String, String> {
    use std::process::Command;

    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        return Err(format!(
            "osascript exited with code {:?}",
            output.status.code()
        ));
    }

    Err(stderr)
}

/// Log every failure; flag Automation denial with a remediation hint. macOS
/// Automation denial surfaces as "Not authorized to send Apple events ...
/// (-1743)"; match only those two reliable markers so an unrelated error is not
/// mislabeled a permission problem.
fn report_failure(player: MediaPlayer, message: &str) {
    let lower = message.to_lowercase();
    let permission_denied = lower.contains("not authorized") || lower.contains("-1743");
    if permission_denied {
        log::warn!(
            "Media control blocked for {}: {message}. Grant Automation access in System Settings > Privacy & Security > Automation.",
            player.app_name()
        );
    } else {
        log::warn!("Media control failed for {}: {message}", player.app_name());
    }
}
