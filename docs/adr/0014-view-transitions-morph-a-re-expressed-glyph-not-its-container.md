# 0014. View transitions morph a re-expressed glyph, not its container

- **Status:** Accepted
- **Date:** 2026-06-17

## Context

`view-transition-name` connects an element across a navigation: when the same
name is present before and after, the browser tweens the old box into the new
one. Artifacts (a recording's `audio`, `transcript`, `transformationOutput`; a
`transformation`) are the clean case, the same object appears in two routes, so
the morph is literally true.

Controls are harder. The home page and the config topbar both express the same
capture choices: the selected recording mode (a mic for manual, an ear for vad),
the input device, and the transcription service. An earlier pass named the whole
control, so navigating home morphed the home hero's 56px bordered glyph box into
the config header's 36px ghost button. That looked like a glitch, and the reason
was diagnosed correctly: the button is persistent chrome, it does not relocate,
and morphing two differently-shaped containers animates a lie about lifecycle.
The over-correction was to forbid every control morph. That conflated two things:
the *container* is chrome, but the *glyph* inside it is a small token, identical
in both routes (the same Lucide icon at the same `size-4`), standing for the same
selected choice. Sliding that token between its two homes is honest about the
small true thing (this is the same choice, expressed here and there) without
claiming the button moved.

## Decision

A `view-transition-name` may bind to a re-expressed control's **glyph**, never to
its container. The glyph must be the same icon at the same size in both routes,
and the morph animates the continuity of a selected choice, not a relocation.

Concretely, the narrow `viewTransition` additions are:

- `recordingMode(trigger)` on the mode glyph: the home mode tab's icon and the
  topbar record button's icon **at rest**. Bound to the icon, not the tab or
  button. Once a recording is live the topbar swaps to a stop control, a
  different object, which must not inherit the name.
- `pipeline.device` and `pipeline.transcription` on the device-selector mic glyph
  and the transcription-service brand glyph, which appear in both the home
  pipeline and the topbar. The transformation stage keeps `transformation(id)`.

Containers still never carry a shared name. The deleted `global.microphone`,
`global.cancel`, `global.header`, and `global.nav` stay deleted: those named the
whole control, the move this ADR still refuses.

## Consequences

- Home-to-config navigation slides the selected mode, device, and model glyphs
  from their home positions to the topbar, reinforcing that the same choice
  persists across the move. The surrounding buttons and labels crossfade.
- The hard rule that prevents the original glitch is a uniqueness invariant: a
  given name may appear at most once in each document. The mode tabs avoid this
  by carrying distinct per-trigger names; the pipeline glyphs avoid it because
  the home pipeline and the topbar never render on the same page. Naming a shared
  control puts the burden of proving single-occurrence on the author, because a
  duplicate makes the browser animate neither and warn.
- The name binds to the glyph at rest only. A glyph owned by a live state machine
  (a stop square, a waveform) is a different object and is left unnamed, so the
  morph never tries to turn a mic into a square.
- Artifact morphs (`recording(id).*`, `transformation(id)`) are unchanged.

## Considered alternatives

- **Forbid every control morph; only artifacts get names.** This was the prior
  decision. Rejected on revisit: it threw out the honest glyph-level morph along
  with the dishonest container-level one. The container is chrome, but an
  identical glyph standing for the same choice in two routes is a true, small
  thing to animate.
- **Morph the whole control (`global.microphone` and friends).** Still rejected.
  Morphing a 56px bordered card box into a 36px ghost button animates a lifecycle
  lie and looks like a glitch; the containers are different chrome that does not
  relocate. Naming only the glyph buys the continuity without the lie.
- **Name the shared glyph inside the component unconditionally.** Rejected: these
  selectors are reused (pipeline and standalone variants, dropdown list rows), so
  a baked-in name would appear many times in one document. The name is passed in
  per call site instead, so each occurrence is deliberate and unique.
