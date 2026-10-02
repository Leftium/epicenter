# 0485. Applications choose editor observation and save policies

- **Status:** Proposed
- **Date:** 2026-10-02

## Context

A checkbox, a title input, and a Markdown editor consume the same folder but
need different interactions. Requiring each to retain a whole-source draft,
debounce input, and offer conflict review makes a product convention into a
storage requirement. A developer may deliberately prefer simpler behavior
that discards unsaved input or replaces another writer's changes.

The folder already exposes reads, captures, conditional replacement, and
explicit overwrite. Those publication conditions do not determine when an
application saves or how it displays incoming content.

## Decision

**Applications independently choose buffer scope, save timing, and adoption of external content.**

| Choice | Application responsibility |
| --- | --- |
| Buffer scope | Submit a command without a local draft, keep one field, keep the body, or keep complete source. |
| Save timing | Submit immediately, debounce, save on blur, or require an explicit action. |
| External observation | Adopt while typing, adopt only while clean, or retain local input until an explicit decision. |
| Publication condition | Use captured conditional replacement or deliberately overwrite current content. |
| Conflict presentation | Show an error, retain input for retry, or offer comparison and resolution appropriate to the edit. |

The folder owns neither Svelte bindings nor save timers. A shared draft
controller is optional application code. A text input does not require the
same buffer scope or schedule as a complete-document editor.

**Each application exposes the consequences of its chosen policy.**

Following external observations while typing can discard input. Keeping a
local buffer and using `files.overwrite(path, source)` can erase another
writer's changes. Keeping a buffer and using `files.replace(capture, source)`
can instead receive a conflict. Retaining a draft does not imply overwrite;
these choices remain independent.

An application choosing comparison retains the original baseline, a current
observation, and its draft. A reviewed conditional save targets the capture
actually presented. Another change can refuse that save again. The application
chooses buttons, notifications, or difference views; the folder supplies no
universal resolution interface.

**Application policy does not change publication facts.**

A successful capture identifies submitted bytes. It does not acknowledge
typing that occurred after submission or describe a later read. A content
version is a SHA-256 hash and byte size, not an edit timestamp or increasing
revision. Returning to identical bytes returns to the same content version.

An in-flight attempt and newer typing are distinct. `Unconfirmed` means the
operation may have completed; reading unchanged content does not establish
that it was cancelled. An application may discard local input, but it cannot
report an unknown outcome as a definite failed save or replay it as though
nothing landed. Change hints request another observation, not an acknowledgement.

`table.update(stem, change)` patches current content and publishes once against
the version read by that call. `table.replace(entry, source)` saves complete
text against the supplied entry. Neither retries a conflict. The captured
`kv.update(snapshot, values)` contract is unchanged.

## Consequences

Developers can build immediate controls, small local buffers, or retained
document editors over one publication contract. No queue, debounce interval,
draft registry, or conflict UI becomes mandatory for every folder consumer.
Applications choosing preservation still own the state and interactions needed
to deliver it. Applications choosing loss accept the corresponding lost input
or overwritten content and still represent save outcomes accurately.

## Considered alternatives

- Require draft preservation everywhere: makes simple controls inherit a
  document editor's state and product promises.
- Make every save overwrite: removes the ability to protect a reviewed baseline.
- Infer interaction policy from widget type: a textarea can edit one field,
  a body, or complete source, and its save policy remains an application choice.
