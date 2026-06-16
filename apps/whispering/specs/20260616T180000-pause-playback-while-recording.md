# Pause playback while recording — greenfield design note

Status: In Progress
Date: 2026-06-16

## Execution status

Scope this pass: **Waves 1–4** (cross-platform core). Wave 5 (bundled read-shim +
auto-resume) and Wave 6 (contextual prompt) are deferred fast-follows.

Stop-and-ask resolved: **hard rename** of `sound.pauseMediaDuringRecording` →
`recording.pausePlayback` (no migration). Old default was `false`, setting was
macOS-only and niche, so the reset cost is accepted.

Grounding (DeepWiki + web, 2026-06-16) confirmed every platform verdict:
- **Windows:** `windows` crate 0.62.x; `TryPauseAsync`/`TryPlayAsync` on the
  *session*; COM not auto-initialized (must `CoInitializeEx(MULTITHREADED)` on a
  dedicated blocking thread, never Tauri's UI/STA thread → `RPC_E_CHANGED_MODE`).
  **Correction folded in:** the blocking await in 0.62 is `IAsyncOperation::join()`
  (re-exported via the `Foundation` feature from `windows-future`), *not* `.get()`;
  `GetResults()` only reads an already-completed op. No manual `windows-future` dep.
- **Linux:** `zbus` v5 pure-Rust, hand-roll MPRIS. `Connection::session()` →
  `DBusProxy::list_names()` → filter `org.mpris.MediaPlayer2.*` → dynamic
  `Proxy::new` on `/org/mpris/MediaPlayer2`. **Nuance:** browsers/multi-instance
  players use suffixed bus names (`...firefox.instance_1_234`), so remember the
  full well-known name and re-read `PlaybackStatus` on resume.
- **macOS:** `MRMediaRemoteSendCommand(int, CFDictionaryRef)->Boolean` is
  synchronous, pass `null` userInfo; Pause=1, Play=0 (canonical symbols are
  `MRMediaRemoteCommand*`, not `kMR*`; integer values unchanged). The 15.4 lockdown
  hit only the read path; commands survive (LyricFever #94, 2025-03-22 is the dated
  linchpin). Plain `#[link(name="MediaRemote", kind="framework")]` extern, no objc2.

- [x] **Wave 1** — re-home setting + opaque-token command pair (macOS still
  AppleScript). Verified: macOS Rust compiles, `bun run check` clean.
  > **Deviation:** the new command signature (`pause_playback() ->
  > Result<Vec<String>>`, `resume_playback(Vec<String>) -> Result<()>`) has no
  > structured-failure channel by design, so the FE one-time Automation-permission
  > *toast* is dropped a wave early (Wave 4 deletes the AppleScript path that
  > raised it anyway). Permission denial is still detected and logged in Rust
  > (`media/macos.rs`). The `PausedSession` opaque token crosses IPC as a plain
  > `String` (named in code, no newtype) to avoid specta newtype edge cases.
  > `media.rs` is now a thin per-OS dispatch boundary; impls live in `media/<os>.rs`.
- [ ] **Wave 2** — Windows GSMTC
- [ ] **Wave 3** — Linux zbus MPRIS
- [ ] **Wave 4** — macOS MediaRemote Tier 2, delete AppleScript

## Product sentence

Whispering owns recording capture quality. The recording lifecycle owns one
cross-platform playback controller that, on capture start, pauses **only** the
system media sessions it observes already playing, remembers exactly that set,
and resumes **only** that set on capture end. It never starts playback that was
not already playing, and never touches sessions it did not pause.

Single owner: `recordingMedia` (`src/lib/operations/media.ts`) on the frontend,
backed by one Rust `media` module exposing `pause_playback` / `resume_playback`
that dispatch per-OS. The recording lifecycle (`operations/recording.ts`) is the
only caller. Nothing else may pause playback.

## Current drift

The shipped feature is `sound.pauseMediaDuringRecording`, and it drifts from the
sentence on three axes:

1. **Wrong owner.** It lives in the `sound.*` group — alongside "play a beep on
   start/stop" toggles — and its UI is on the Sound settings page
   (`settings/sound/+page.svelte:24`). But this is a *capture-quality* decision,
   not a sound-effect decision. It is grouped with its opposite concern (sounds
   Whispering *emits*) instead of with recording.

2. **App-specific, not system-wide.** `media.rs` AppleScripts exactly two apps,
   Music and Spotify (`MediaPlayer` enum, `media.rs:5`). It misses the single
   largest contamination source for a transcription app: browser / YouTube /
   web-audio playback. The product promise ("reduce background playback
   contamination across the system") is not met; the code keeps a promise about
   two named apps.

3. **macOS-only.** `shouldPauseMedia()` gates on `os.isApple` (`media.ts:22`).
   Windows and Linux users get nothing, despite both platforms having a *better*
   native API for this than macOS does.

What is **not** drift — keep these, they earn their keep:

- The `chain` promise model in `media.ts:19-100`. Serializing every pause/resume
  onto one promise tail, where the resolved value *is* the "what did I pause"
  set and doubles as the "currently paused" flag, is a genuinely good design. It
  makes a late resume unable to race a fresh pause from a quick stop/start, and
  guarantees both helpers always resolve so the chain never wedges. The new
  backend keeps this model verbatim; only the element type changes
  (`MediaPlayer[]` → opaque `string[]` session tokens).
- Fire-and-forget from the recording path. Recording never waits on and never
  fails because of playback control. Preserve.
- Resume-only-what-we-paused. The current code already only resumes players it
  paused; this is the core safety invariant and it generalizes cleanly.

## Proposed behavior

Canonical behavior is **system media-session pause**, not app-specific
integrations. Every supported OS exposes a system media-session layer with a
real, separate pause command and a per-session playing-state query. We use it.

Lifecycle:

1. **Capture start** (manual record start, VAD listen start): query the system
   for sessions whose state is *Playing*. Pause exactly those. Remember their
   identities (bundle id / AUMID / MPRIS bus name) as an opaque token set.
2. **Capture end** (stop, cancel, failed start): re-resolve each remembered
   session by identity and send *play* to those still present. Drop the set.

This is gated so we **never start playback**: we send the dedicated *pause*
command (never a play/pause toggle), and we only ever send *play* to a session
we personally observed playing and paused. A session that vanished, was already
resumed by the user, or can't be paused is silently skipped.

### Resume: keep it, but make it earn its trust

The question "should resume exist, or is pause-only safer?" resolves to: **keep
resume, because we gate it on a remembered identity-matched set.** Auto-resume is
only dangerous when it's a blind toggle. Ours isn't — it can only re-play the
exact sessions we paused. The safety rule is one line:

> Never send *play* unless the target is in the remembered paused set.

Where that remembered set is unreliable (see macOS read-path fragility below),
degrade to **pause-only, no auto-resume** rather than risk a surprise resume.
Pause-only is the safe floor; resume is the enhancement on top.

### Interaction matrix

| Event | Behavior |
| --- | --- |
| Manual start | Query + pause playing set, remember it. |
| Manual stop / cancel / failed start | Resume remembered set, drop it. (Already wired in `recording.ts`.) |
| VAD listen start | Pause for the **whole listening session**, not per-utterance. See note. |
| VAD listen stop / cancel | Resume remembered set. |
| VAD per-utterance (speech end) | Do **not** resume between utterances. |
| Quick stop→start race | The `chain` serializes; a late resume can't clobber a fresh pause. |
| User manually starts new playback mid-recording | Not in our set → we never touch it on resume. |
| User manually resumes our paused item mid-recording | Resume sends play to an already-playing session → harmless no-op. |
| User manually pauses something else mid-recording | Not in our set → we don't resume it. |
| Nothing playing at start | Empty set → pause is a no-op, resume is a no-op. |

**VAD note (a real fork, decided):** VAD "listening" is long-lived; it only
captures on detected speech. Two options: (a) pause for the entire armed
session, or (b) pause on speech-start / resume on speech-end. Option (b) churns
the user's playback — pause/resume flicker on every utterance — which is far
more surprising than (a). And background music degrades VAD *detection* itself,
not just the captured clip, so pausing only during speech is too late anyway. So
(a): pause when listening arms, resume when it disarms. The cost — music stays
paused through idle listening — is the honest price of VAD mode and matches the
current code's shape. Call it out in copy if VAD ever surfaces this.

## Platform capability matrix

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| System media layer | MediaRemote.framework (private) | `Windows.Media.Control` (GSMTC) | MPRIS over session D-Bus |
| Per-session "is playing" query | Yes, but read path is **entitlement-gated since macOS 15.4** → needs the perl-adapter shim | Yes: `PlaybackStatus == Playing` per session via `GetSessions()` | Yes: `PlaybackStatus == "Playing"` per player |
| Dedicated pause (not toggle) | Yes: `kMRPause` (1) ≠ `kMRTogglePlayPause` (2) | Yes: `TryPauseAsync()` ≠ `TryTogglePlayPauseAsync()` | Yes: `Pause()` ≠ `PlayPause()` |
| Covers browser / YouTube | Yes | Yes (browsers register SMTC; gated by `#hardware-media-key-handling`, default on) | Yes (Chrome/Firefox native MPRIS since v81) |
| Remember + resume a set | Yes (now-playing bundle id) | Yes (re-resolve by `SourceAppUserModelId`) | Yes (re-resolve by bus name) |
| Rust path | `#[link(name="MediaRemote", kind="framework")]` extern for `kMRPause`/`kMRPlay` (or the maintained `media-remote` crate v0.4.1) — no objc2; perl-adapter (`ungive/mediaremote-adapter`) for the Tier-1 read | Official `windows` crate v0.62 (`Media_Control` + COM features) — no extra dep | **`zbus` v5** (pure Rust, async), hand-roll ~5 MPRIS calls — avoids `mpris`/libdbus C build dep |
| Viability risk | **Private API**, Apple already restricted reads once at 15.4; commands reportedly still work. Notarized/Developer-ID OK; App Store would reject. Must stay non-sandboxed. | Stable, documented, public. Works for unpackaged Win32 (no MSIX capability needed). Fails only when run as a service/SYSTEM. | Stable, spec'd. Needs a session bus (absent headless). Flatpak needs `--talk-name=org.mpris.MediaPlayer2.*`. |
| Known coverage holdouts | Single system now-playing app only | Prime Video, Kodi, PotPlayer, some others never register SMTC | `spotifyd` and some clients misreport status |

Three structural facts make the whole feature buildable as designed:

- **A real pause-only command exists on all three platforms.** We are *not*
  stuck with overloaded play/pause toggles. The only toggle-only path is HID
  media-key injection (macOS F8 / `CGEventPost`), which we **refuse** — it can't
  query state and starts playback when nothing is playing.
- **We can query playing-state before acting on all three** (with the macOS
  caveat that the read needs the adapter shim on 15.4+).
- **We can remember and identity-match the paused set on all three.**

The honest weak spot is **macOS**: the platform with the worst API for this is
also our flagship. Verified: the 15.4 lockdown hit **only** the read/GET path;
the *commands* (`kMRPause`/`kMRPlay` via `MRMediaRemoteSendCommand`) are not
restricted and still work via a direct framework link. So Tier 2 (commands-only)
needs no shim and no private framework bundled into our binary at all — we just
link `MediaRemote` and send. Only the *read* ("is anything playing") needs the
`ungive/mediaremote-adapter` perl shim (Apple grants MediaRemote read access to
`com.apple.*` bundle ids; system `perl` qualifies), and that shim is only pulled
in for Tier 1. **Caveat:** the strongest dated evidence that the send command
survives is March-2025 (15.4 beta) reports + 2026 community consensus + an
actively-maintained crate shipping it. Smoke-test `kMRPause` on the current
target OS before locking Tier 2 in.

## Recommended Rust / platform approach

One Rust `media` module, one trait, three `cfg`-gated impls, one Tauri command
pair. Delete the `MediaPlayer` enum, the AppleScript, `pgrep`, and `osascript`.

```rust
// Opaque to the frontend. Platform-specific identity inside.
pub struct PausedSession(String); // macOS bundle id / Win AUMID / MPRIS bus name

#[tauri::command] pub async fn pause_playback() -> Result<Vec<PausedSession>, String>;
#[tauri::command] pub async fn resume_playback(sessions: Vec<PausedSession>) -> Result<(), String>;
```

- **macOS:** one mechanism (MediaRemote), three degradation tiers on the
  *read-availability* axis — **not** a second mechanism. Progressive enhancement
  lives inside the single path:
  - **Tier 1 (full):** read playing-state + now-playing bundle id via the
    perl-adapter (`ungive/mediaremote-adapter`, run once as a long-lived `stream`
    subprocess, state cached so record-start pays no spawn latency) → pause via
    `kMRPause`, remember, resume via `kMRPlay`. Best UX.
  - **Tier 2 (no read shim):** `dlopen` MediaRemote and send `kMRPause` on start
    (safe: pause-only never starts idle playback), **no auto-resume**. ~30 lines
    of Rust, zero bundled perl, no subprocess to supervise. This is what macOS
    ships first.
  - **Tier 3 (commands break on a future OS):** no-op. Recording never blocked.

  The tiers degrade one mechanism; they are not parallel paths. See the
  AppleScript refusal for why we do not layer a second mechanism underneath.
- **Windows:** official `windows` crate v0.62. Manager: `RequestAsync()` →
  `GetSessions()`. Per **session** object (not the manager): if
  `GetPlaybackInfo().PlaybackStatus() == Playing`, collect `SourceAppUserModelId`
  and `TryPauseAsync()`. On resume: re-fetch, match stored AUMIDs still present,
  `TryPlayAsync()`. Never `TryTogglePlayPauseAsync()`. **Footgun:** the crate
  does not auto-init COM — `CoInitializeEx(MULTITHREADED)` on the calling thread
  and run the whole interaction inside `spawn_blocking`; never block on a WinRT
  async result from the tokio command/UI thread (deadlock + `RPC_E_CHANGED_MODE`,
  apartment can't change once set). Resolve async ops with `GetResults()` (in
  `windows-future` for 0.62), not an assumed `.get()`. Features:
  `["Media_Control", "Foundation", "Foundation_Collections", "Win32_System_Com"]`.
- **Linux:** **`zbus` v5** (pure Rust, async), hand-rolling the ~5 MPRIS calls —
  chosen over the `mpris` crate to avoid the C `libdbus`/`pkg-config` build deps
  in our `.deb`/AppImage and its blocking API. `Connection::session()` →
  `list_names()`, filter `org.mpris.MediaPlayer2.*` → per name, proxy
  `/org/mpris/MediaPlayer2` iface `org.mpris.MediaPlayer2.Player`, read
  `PlaybackStatus`, keep `== "Playing"`, call `Pause()`, remember the bus name.
  On resume: `Play()` on remembered names still present. No-op (degrade
  gracefully) if there is no session bus (headless). If shipping Flatpak, add
  `--talk-name=org.mpris.MediaPlayer2.*`. (No maintained pure-Rust MPRIS *client*
  crate exists, so hand-rolling on `zbus` is the lean path, not a workaround.)

Windows and Linux run off the recording hot path (`spawn_blocking` for the
blocking WinRT accessors / async D-Bus round-trips) and return `Result` so a hung
player or D-Bus stall never interrupts capture. The macOS Tier-2 send is a
synchronous C call (`MRMediaRemoteSendCommand(1, null)`, no dispatch queue, no
completion block) — fast enough to call inline.

The frontend `recordingMedia` chain is unchanged except `MediaPlayer[]` →
`PausedSession[]` (opaque `string[]`). The chain still answers "what did I
pause," still serializes, still always resolves.

## Setting location and copy

**Move it out of Sound into Recording.** This is the ownership fix.

- New key: `recording.pausePlayback` (workspace KV, roaming — the *intent* to
  pause is a user preference like the sound toggles, even though capability is
  per-device). Default `false`.
- Delete `sound.pauseMediaDuringRecording`.
- UI: a `SettingSwitch` on `settings/recording/+page.svelte`, no longer
  platform-gated to Apple (all three platforms now support it).

**Default: off, but discoverable at the moment it matters.** Rejected
alternatives:

- *On by default*: silently pausing a user's music the first time they ever
  record is a startling, trust-eroding surprise. No.
- *Off + buried in settings*: safe but most users never find it and silently
  suffer contamination. The current failure.

Recommended: **off by default + a one-time contextual prompt.** The first time
capture starts *while something is actually playing*, ask in-context:

> Something's playing. Pause it while you record?
> [Pause this time] · [Always pause] · [Not now]

"Always pause" flips `recording.pausePlayback` on. This converts discovery into
the exact moment the feature is relevant, and never auto-pauses without consent.
Ship the toggle first (Wave 1); the contextual prompt is a fast-follow (Wave 6).

**Do not split into "pause" and "resume after."** A split only earns its keep if
auto-resume is unsafe — and we've made it safe (resume only the remembered set).
The split is a weak "keeps options open" trigger. Refuse it; one toggle.

**Copy (does not overpromise — coverage is best-effort):**

- Label: `Pause playback while recording`
- Description: `When recording starts, Whispering pauses media playing on your
  computer (music, video, browser tabs) and resumes it when you stop. Works with
  most apps that appear in your system media controls; a few apps can't be
  paused this way.`

The "most apps … a few can't" phrasing is load-bearing honesty: SMTC/MPRIS/
MediaRemote coverage is opt-in per app, and named holdouts exist on every
platform.

### Home-screen recording cluster (broader thought)

The moment-of-recording settings that deserve to be reachable from the home
screen — not buried — are the ones you'd want to change *right before you hit
record*:

- recording mode (manual vs VAD),
- microphone device,
- pause-playback-while-recording.

Recommend a compact disclosure (popover or a thin row) next to the record button
exposing these three, rather than dragging full settings onto the home screen.
Out of scope for this note beyond naming the cluster; the pause-playback toggle
is the first member that justifies building it.

## Edge cases

- **Nothing playing at start** → empty set; pause and resume both no-op.
- **macOS read shim unavailable** → pause-only, no auto-resume (safe floor).
- **macOS command path dies on future OS** → no-op; recording unaffected.
- **Session vanished before resume** → skipped (re-resolve by identity, tolerate
  absence).
- **User manually resumed our paused item** → resume is a harmless no-op.
- **Multiple simultaneous players** → on Windows/Linux, `GetSessions()` /
  `find_all()` pause all; do not use single-current-session APIs.
- **Multiple simultaneous players on macOS** → **accepted limitation.**
  MediaRemote is single-target: it pauses only the one app macOS considers "now
  playing." If Spotify and a browser tab both play, only the now-playing one
  pauses. Rare enough to accept (the now-playing app is usually the loud one the
  user just touched); named so no one is surprised. This is the cost of refusing
  the AppleScript layer.
- **No session bus on Linux (headless/SSH)** → `PlayerFinder::new()` errors →
  feature no-ops.
- **App run as Windows service/SYSTEM** → GSMTC can't resolve sessions →
  no-ops. (Not a normal Tauri launch.)
- **`CanPause == false` (Linux) / app declines `TryPauseAsync` (Windows)** →
  skipped, not an error.
- **Quick stop→start** → `chain` ordering guarantees correctness.

## Implementation plan

Waves are independently shippable and dependency-ordered.

1. **Wave 1 — re-home the setting + broaden the trait (macOS still
   AppleScript).** Rename `sound.pauseMediaDuringRecording` →
   `recording.pausePlayback`; move the UI to Recording settings, drop the
   Apple-only gate at the schema/UI level. Introduce the `PausedSession` opaque
   token type and the `pause_playback`/`resume_playback` command pair, with the
   existing macOS AppleScript wired behind it temporarily. Frontend chain switches
   to `string[]`. **Durable-string change — confirm before landing** (see below).
2. **Wave 2 — Windows.** `windows` crate GSMTC impl. First platform on the new
   canonical path.
3. **Wave 3 — Linux.** `zbus` v5 hand-rolled MPRIS impl. Flatpak manifest
   `--talk-name` if/when Flatpak ships.
4. **Wave 4 — macOS MediaRemote Tier 2 (commands-only), delete AppleScript.**
   **Gate this wave on a smoke-test:** confirm `MRMediaRemoteSendCommand(1, null)`
   actually pauses on the current target macOS before committing. Then wire a
   `#[link(name = "MediaRemote", kind = "framework")]` extern (or depend on the
   `media-remote` crate v0.4.1) and send `kMRPause` on start, **no auto-resume**
   yet. No objc2, no dispatch queue, no bundled framework. Delete the
   `MediaPlayer` enum, `osascript`, `pgrep`, the AppleScript strings, and the
   macOS-only permission-hint plumbing in `media.ts`. This alone is already
   better than today (covers browsers). Ship macOS on the validated abstraction
   before taking the heaviest dependency.
5. **Wave 5 — macOS Tier 1 (read shim + resume).** Add the
   `ungive/mediaremote-adapter` (BSD-3) — a perl script **plus a precompiled fat
   `MediaRemoteAdapter.framework`** — as a supervised long-lived `stream`
   subprocess for the playing-state read, enabling remember + auto-resume.
   Notarization: our app spawns `/usr/bin/perl` which loads the framework, so our
   own process never `dlopen`s it → no `disable-library-validation` needed; we
   still sign the bundled `.framework` + `.pl` as embedded resources with our
   Developer ID, and watch the known Tauri `externalBin` notarization friction
   (tauri#11992). Only worth it once Tier 2 has proven the mechanism in the wild;
   this is the wave that pays the maintenance cost for the resume that feels
   magic.
6. **Wave 6 — contextual prompt.** One-time "Something's playing — pause it?"
   prompt on first record-while-playing, with "Always pause" flipping the
   setting.

Each wave keeps recording fire-and-forget and never blocks capture.

## Explicit refusals

- **HID media-key injection (macOS F8 / `CGEventPost`, blind key toggles
  anywhere).** Can't query state; toggles *start* playback when idle. Violates
  "never start playback." Refused on all platforms.
- **Play/pause toggle commands** (`kMRTogglePlayPause`,
  `TryTogglePlayPauseAsync`, `PlayPause()`). Same reason. Use the dedicated pause
  everywhere.
- **Layering AppleScript under MediaRemote on macOS (two parallel mechanisms).**
  Refused, for three concrete reasons:
  1. *It insures the wrong failure.* The known, already-happened macOS problem is
     the read gate (15.4). AppleScript would back up the *commands* — which still
     work. So a parallel AppleScript path hedges the less-likely failure while
     the real risk is already covered by the Tier 2 degradation.
  2. *Browser coverage is the whole point, and AppleScript can't touch it.* For a
     transcription app, YouTube / web audio is the dominant contamination. We pay
     the MediaRemote cost regardless; once paid, AppleScript only adds the rare
     "Spotify *and* a browser tab playing simultaneously" case.
  3. *Two mechanisms mean coordination + dedup* (pause Spotify via both paths →
     resume fires twice), which is exactly the maintenance we're minimizing.

  *Revisit trigger: if the MediaRemote **command** path (not the read) dies on a
  shipped macOS release, promote AppleScript-for-known-apps as the macOS impl.
  Documented escape hatch, not built now.*
- **Adding new app-specific integrations** (Spotify Web API, per-app scripting).
  The platform path covers them via the system session. An app-specific path is
  only allowed if it is *strictly better* and lives behind the one canonical
  `PausedSession` abstraction — none currently qualifies.
- **Splitting the setting into pause + resume toggles.** Auto-resume is safe
  because it's set-scoped; the split is a hypothetical-future option.
- **Per-utterance VAD pause/resume.** Churns playback; refused in favor of
  pause-for-session.
- **`MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` / `souvlaki`.** These
  *expose your own* app's playback to the OS; they cannot control other apps.
  Wrong tool, named here so no one reaches for them.

## Narrower promise if safe cross-platform pause/resume were impossible

It is not impossible — all three platforms have real pause-only commands and
state queries. The only place the full promise frays is the **macOS read path**
(15.4+ entitlement gating). If the perl-adapter shim proves unviable in
distribution, the honest narrower promise on macOS becomes:

> "Whispering pauses system playback while recording" — **pause-only, no
> auto-resume** on macOS, full pause+resume on Windows and Linux.

Pause-only is still safe and still meets the core capture-quality goal; resume is
the part that depends on the fragile read. We never degrade to a blind toggle to
keep resume — that trade isn't worth a surprise.

## Stop-and-ask

`recording.pausePlayback` replaces a durable, synced KV key
(`sound.pauseMediaDuringRecording`). Renaming it means any user who had enabled
the old macOS-only setting reverts to the `false` default. Given the old default
was `false`, the setting is macOS-only and niche, the loss is small — but it is a
durable-string change. **Confirm the rename (vs. a one-time read-old-write-new
migration) before landing Wave 1.**
