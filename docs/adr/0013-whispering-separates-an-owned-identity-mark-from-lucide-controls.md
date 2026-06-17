# 0013. Whispering separates an owned identity mark from Lucide controls

- **Status:** Accepted
- **Date:** 2026-06-16

## Context

One Lucide `Mic` glyph carries three jobs at once: the brand mark in the
sidebar, the manual recording-mode icon, and the idle record button. A new user
cannot tell whether the mic means "this app," "this mode," or "press to record,"
because it means all three. The app also runs three icon vocabularies in
parallel: Lucide in the UI, emoji in constant tables (`RECORDING_MODE_OPTIONS.icon`,
plus the never-rendered `RECORDER_STATE_TO_ICON` and `VAD_STATE_TO_ICON`), and
emoji-bitmap PNGs in the tray (`studio_microphone.png` and siblings, named after
emoji shortcodes). The menubar and the app therefore disagree on what a
microphone looks like, personality is scattered across three systems, and the
brand is the same drawing as the button.

## Decision

Whispering's iconography is two tiers, and the tiers never share a drawing.

Tier 1 is identity: one owned, illustrative recording mark, authored once as an
SVG. It appears in exactly two places, the home hero and the tray idle icon (the
tray PNG is an export of the same SVG), so the menubar and the app share one
face. It is decorative and static; it does not state-switch. The brand mark is
never the same glyph as the action.

Tier 2 is control: Lucide everywhere, state-driven, deliberately quiet. Manual
is `Mic` and `Square` (recording), voice-activated is a listening glyph and
`AudioLines` (speech detected), upload is `FileUp`. One resolver owns the
state-to-glyph mapping; render sites own their own sizing and chrome.

Emoji appear only as voice in prose (the `❤️` in "Free and open source ❤️"),
never as functional iconography. The studio-mic emoji PNG is a mood reference for
Tier 1, not a shipped brand asset: it is rented emoji art with no clear license
and a glossy, skeuomorphic register that clashes with the flat UI. Web UI never
reaches into `src-tauri` for an image; a shared asset is given a frontend home.

## Consequences

- The brand is legible as the brand. The sidebar mark stops being the action
  glyph, so "this app" and "press to record" read as different things.
- The menubar and the home screen become the same object once the Tier-1 mark is
  drawn, instead of an emoji bitmap in the tray and a Lucide line in the app.
- The dead emoji state tables are deleted, the emoji `icon` field on the mode
  options is dropped, and `ActivationStep` renders the Lucide mode icons, so
  there is one mode-to-glyph owner instead of two that disagree.
- Personality concentrates in two deliberate places (the Tier-1 mark and the
  recording-state motion) rather than diluting across emoji, PNG, and glyph
  reuse. Everything functional is disciplined Lucide.
- The specific Tier-1 art is still pending. This ADR fixes the tier *structure*,
  not the drawing; shipping can proceed with a large Lucide mic standing in on
  the hero and swap the owned mark in when it exists.

## Considered alternatives

- **Ship the studio-mic emoji PNG as the hero/brand.** Rejected: unclear license
  on rented emoji art used as a product face, a glossy 3D register that clashes
  with the flat Lucide/shadcn UI, and no ability to theme, scale, or animate it.
  Kept as a mood reference for an owned redraw.
- **Pure Lucide everywhere, no identity tier.** Rejected: a thin line mic on the
  hero is anemic and the app loses its personality. Lucide is right for controls,
  not for the one place the brand should have character.
- **One glyph for brand and action, as today.** Rejected: it is the root
  confusion this ADR removes.
