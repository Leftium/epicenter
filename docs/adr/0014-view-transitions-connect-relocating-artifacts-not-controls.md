# 0014. View Transitions connect relocating artifacts, not controls

- **Status:** Accepted
- **Date:** 2026-06-16

## Context

`view-transition-name` was bound to two different kinds of element. Artifacts
(a recording's `audio`, `transcript`, and `transformationOutput`; a
`transformation`) genuinely appear as the same object in two routes, so morphing
them between list and detail is honest. Controls were also named: `global.microphone`
sat on both the home hero's 56px bordered glyph box and the config header's 36px
ghost button, so navigating home to a config page morphed one into the other.
`global.cancel` had the same split. `global.header` sits on the persistent config
layout, whose DOM is never replaced, so it animates nothing. `global.nav` is
unused. The control morphs are the source of the "this looks like a glitch"
feeling: a morph claims one object relocated, but the record button does not
relocate. It persists as chrome on every config page and re-expresses on the
hero.

## Decision

A `view-transition-name` means one thing: this exact object relocated between two
routes and should morph. Bind it only to artifacts that appear as the same object
in two places. Controls are persistent or re-expressed chrome and never carry a
shared transition name; they crossfade with the page like everything else.

Keep `recording(id).audio`, `recording(id).transcript`,
`recording(id).transformationOutput`, and `transformation(id)`. Delete
`global.microphone`, `global.cancel`, `global.header`, and `global.nav`. The
entire `global` namespace in `viewTransitions.ts` is removed.

## Consequences

- The home-to-config navigation stops morphing a bordered card glyph into a ghost
  button. The control crossfades, which matches what it actually is.
- The list-to-detail artifact morphs (play the same recording's audio, open its
  transcript) are preserved, because those are the same object relocating.
- The rule is stated as a test for future work: before adding a transition name,
  name the single object that relocates. If you cannot, it is chrome, and it gets
  no name.
- The artifact name strings (`recording-<id>-audio` and friends) are a contract
  between the two routes that share them. Renaming one desyncs the morph, so the
  strings stay stable.

## Considered alternatives

- **Keep the microphone morph, make the two glyph containers geometrically
  compatible.** Rejected: the record button persists as chrome and does not
  relocate, so even a clean morph tells a lie about its lifecycle. Compatible
  geometry would buy a smoother lie.
- **Delete all view transitions for maximum simplicity.** Rejected: the artifact
  morphs are a real, cheap delight and the same object genuinely appears twice.
  The cost was never the artifacts; it was the controls.
