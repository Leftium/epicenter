# Playback pause tracks the speaking window, not the recording session

**Status**: Draft

## The asymmetric win in one line

Replace the feature's rationale ("pause to keep the recording clean") with one
invariant the user actually holds: **no music in my ears while I am producing
speech.** That single rule derives both behaviors, deletes the worst wart of the
current design, and reuses infrastructure that already exists, at the cost of a
documented degradation for the niche nobody in this decision occupies (VAD on
speakers).

## The invariant

> Music must not be playing while the user is producing speech to be captured.

It is upstream of the manual/VAD split. The "speaking window" is defined per
mode, and pause/resume track that window:

- **Manual** (press-to-talk): the whole press -> release hold *is* the speaking
  window. Pause for the whole recording. **Unchanged from today.**
- **VAD** (voice-activated): the speaking window is each *detected utterance*.
  Pause on speech start, resume on speech end. **This is the change.**

Today VAD pauses at *arm* and resumes at *disarm* (`recording.ts:205` /
`:268,:282`), so music is dead for the entire armed session, including the long
idle gaps of an always-armed "listen from anywhere" global-shortcut session.
The invariant says music should play during those gaps and stop only while you
speak.

## Why this collapses (and where it does not)

It deletes:

- The arm-time-vs-per-utterance debate. The behaviors are *derived* from the
  invariant, not chosen.
- The "music dead during a long armed-idle VAD session" problem, for free.

It reuses, not builds:

- The VAD recorder already flips `LISTENING <-> SPEECH_DETECTED`
  (`vad-recorder.svelte.ts:69,177,181,188`) and already hands `recording.ts` the
  `onSpeechStart` / `onSpeechEnd` / `onVADMisfire` callbacks
  (`recording.ts:207-238`). We hang two existing calls off events that already
  fire. No new detection.

It does **not** collapse into a single universal behavior, and we are honest
about the one place it costs: **VAD on speakers.** There, music keeps playing
while armed-idle, so the mic hears it and (a) VAD onset detection degrades and
(b) the first ~200 ms of each utterance plays over the music before the async
pause lands. On **headphones, neither happens** (clean mic, clean recording,
clean detection). This is a deliberate purpose reframe: capture-quality ->
"no music while I speak" (courtesy), assuming headphones.

This **reverses ADR-0017's VAD-timing decision** (which rejected per-utterance on
exactly the speaker-degradation argument). The reversal is documented, not
silent (Wave 4). The cross-platform command/token architecture in ADR-0017
(`pause_playback`/`resume_playback`, opaque tokens, the per-OS modules) all
stands; only the *when* for VAD changes.

### Decision: accept the speaker degradation, no output-routing detection

Auto-detecting headphone-vs-speaker to branch behavior re-introduces the two
behaviors we just collapsed and is fragile across OSes. Refused. The quick-toggle
popover (Wave 2) is the escape hatch for anyone who wants music while recording.

## Comparable grounding

System-media control is the right layer (ADR-0017 settled this). The novel part
here is *timing*. The closest analogy is how a phone/VoIP call ducks system
media for the duration you are on the call, not for the duration the app is open.
Per-utterance pause is that same "duck while the channel is hot" model, with VAD
speech detection as the hot-channel signal.

## Plan (each wave a standalone PR)

### Wave 0 (done): branch off merged main

Worktree `/Users/braden/Code/.worktrees/epicenter-playback-pause`, branch
`feat/whispering-playback-pause-ux`, off `origin/main`
(`ce5d25714`, contains the merged pause-playback feature `76f9674a5`).

### Wave 1: default-on (no toast)

The feature is invisible at `default false`. Flip it on. Just the default flip,
nothing else.

- `workspace/definition.ts:250`: `recording.pausePlayback` default
  `() => false` -> `() => true`.

Discoverability needs no runtime nudge. The settings toggle already carries a
full description (`settings/recording/+page.svelte`), and Wave 2 puts a **Pause
playback** toggle directly on the home model row: permanently visible, one click
to disable, right where you record. That is strictly better than a one-time
toast, which fires once on first success (when nothing is wrong and the user is
reading their transcript) and is long gone by the time anyone forms the question
"why does my music keep pausing?".

A first-fire toast gated on a `deviceConfig` notices flag was considered and
rejected on exactly this reasoning: it explained the *non-surprising* half
(pausing media during voice capture is least-astonishment, like a phone call
ducking music), said nothing about the genuinely surprising half (a best-effort
resume that fails), and would have opened a `notices.*` namespace in a config
store that until then held only secrets, hardware, paths, and shortcuts. Wave 2
makes it redundant. No flag, no toast.

### Wave 2: quick-behavior popover on the model row

One `sliders`/`ellipsis` ghost-icon appended to `CapturePipeline.svelte`
(rendered at `+page.svelte:234,249,304`), opening a `@epicenter/ui/popover`
hosting `SettingSwitch` toggles, mirroring the existing pill/popover grammar of
`ManualDeviceSelector.svelte`.

- Toggles: **Pause playback** (`recording.pausePlayback`), **Paste at cursor vs
  clipboard** (output mode key), **AI cleanup** (transformation key). Verify the
  exact KV keys during build.
- Reuse `SettingSwitch.svelte` verbatim -> same workspace-KV write as Settings,
  zero drift.
- Discipline: per-session behavioral booleans only. No pickers (device/model
  stay as pills). No set-and-forget config (bitrate/sample-rate stay in
  Settings).
- Copy: no em dashes. Trigger tooltip "More options".
- Complements default-on: this is the per-session "off right now" escape.

### Wave 3: VAD per-utterance (the clean break) -- lands with Wave 4's ADR

In `operations/recording.ts`, `startVadRecording`:

- **Remove** the arm-time `recordingMedia.pause()` (line 205).
- `onSpeechStart` (line 209): `recordingMedia.pause()`.
- `onSpeechEnd` (line 215): schedule a **debounced** `recordingMedia.resume()`.
- Pass `onVADMisfire`: cancel pending debounce + `recordingMedia.resume()` (a
  false start must undo the pause).
- Keep `recordingMedia.resume()` on the start-error path (line 241).
- `stopVadRecording`: cancel any pending debounce + `recordingMedia.resume()`
  immediately (disarm mid-utterance must never leave music dead).

Hysteresis (flutter prevention): on speech end, wait ~1-1.5 s before resuming;
a new `onSpeechStart` cancels the pending resume. **Own the timer in the VAD
coupling (recording.ts module scope), not in `media.ts`** so `media.ts` stays a
dumb serialized chain and manual-stop keeps its immediate resume. VAD's own
redemption frames already delay `onSpeechEnd`; do not double-stack a sluggish
resume.

**Manual: untouched** (`startManualRecording:79`, `stop:113,129`,
`cancel:171`). Do not speech-detect a press-to-talk window.

### Wave 4: docs

- New ADR superseding ADR-0017's VAD-timing decision: "Playback pause tracks the
  speaking window; VAD pauses per detected utterance, not per armed session."
  Record the purpose reframe (courtesy/headphones), the speaker-degradation
  caveat, the hysteresis, that manual stays whole-window, and that ADR-0017's
  command/token architecture is unchanged. Add its row to `docs/adr/README.md`;
  this spec is then deleted (two-state lifecycle).
- Optional `docs/CONTEXT.md` term: **speaking window** (manual = key-hold; VAD =
  detected utterance).

## Risks to watch

- macOS rapid pause/resume robustness; the existing promise-chain serializes,
  and the debounce reduces command frequency.
- The debounced resume must be reliably cancelled by the next `onSpeechStart`.
- Confirm the output-mode and AI-cleanup KV keys (Wave 2) before wiring.

## Sequencing

Wave 1 and Wave 2 are independent and independently shippable. Wave 3 must land
with Wave 4 (the ADR reversal). Recommended order: 1 -> 2 -> (3 + 4).
