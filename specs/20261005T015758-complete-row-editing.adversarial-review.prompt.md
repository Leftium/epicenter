# Review the flattened complete-row editor

**Date:** 2026-10-05
**Status:** Draft
**Scope:** Read-only focused challenge of the agreed row snapshot contract

The [execution plan](20261005T015758-complete-row-editing.md) owns remaining work.
The [decision record](../docs/adr/0504-row-editors-own-complete-input-and-one-publication-queue.md)
owns the intended contract. Current runtime still implements the previous editor.
Do not edit the checkout or launch child reviewers.

## Fixed outcome

The user explicitly chose this public interface. Challenge implementation
ambiguities and incorrect guarantees against it; do not restore discarded
wrappers or continuing live views as an unsolicited alternative.

```ts
type RowState<TFields> =
  | {
      readonly status: 'valid';
      readonly text: string;
      readonly fields: DeepReadonly<TFields> & Readonly<Record<string, CanonicalValue>>;
      readonly body: string;
    }
  | { readonly status: 'invalid'; readonly text: string; readonly error: RowError }
  | { readonly status: 'unreadable'; readonly error: ReadError };

type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'failed'; readonly error: SaveError };
```

`editor.row` and `editor.save` are tracked getters. No standalone `editor.text`,
`.value`, `.current`, or `.readError` exists. Invalid readable rows offer raw
repair; unreadable exposes only error and hides both live editing views.
Continuing unsaved application drafts live in `$state` above that conditional.

One framework-neutral native owner exposes `get`, invalidation-only `subscribe`,
complete `set`, raw `setText`, and `refresh`. One thin `fromRowEditor` adapter
adds reactive getters and forwards setters/refresh without copying values.
Subscribers own observation lifetime; outstanding publication does not depend
on a component being mounted. There is no public disposal/adoption/settlement
protocol. Applications retain the owner until admitted work settles or failed
input is deliberately retained/discarded.

## Snapshot rule to challenge

1. Acquisition starts with the whole observed file text.
2. `set` synchronously owns and canonically formats all fields/body. After
   representation succeeds, the formatted text becomes current accepted input
   before return. Parse that text to construct the readable public row.
   Read only fields/body; variant status and stale text are ignored by formatting.
3. `setText` synchronously owns raw text. The same text becomes current input
   before return; its complete parse/validation determines valid or invalid.
4. Valid text, fields, and body come from that one immutable capture. Unknown
   metadata survives complete parsing; partial conformance output cannot supply
   a replacement. Omitted supplied keys are deleted; there is no disk-key merge.
5. Backing unreadability masks the public snapshot. Accepted input and captures
   remain private; there is no hidden public text or last-valid accessor. A
   setter can accept application input while unreadable without opening a live view.
6. A successful current read can restore readability without adopting disk text.
   Pending or failed input remains the public source when the gate reopens.
7. Whole observed disk input may be installed only when no active, pending, or
   failed publication needs protection, no newer input occurred since the read
   began, and no publication settlement invalidated the observation.
8. Receipts settle their submitted capture. They never replace a newer public
   input or combine a newer field map with older text.

## Publication and observation constraints

- Complete structured and raw input share one active/latest-pending queue.
  Setters acknowledge acceptance, not generation-specific publication.
- Saving becomes visible synchronously at admission. No idle gap can appear
  while pending input remains. Failure or uncertainty pauses the entire chain,
  including newer pending input. Same-value explicit setters start new attempts.
- Existing-row `table.replace(stem, text, {})` must check presence at actual
  publication. No resurrection. Independent writers are last-publication-wins.
- Schema-invalid representable input can publish. Raw input that cannot
  round-trip through UTF-8 stays held with a representation publication failure.
  While readable it projects invalid text/error. Its failure surfaces on its
  queue turn after any older active attempt, never as a second simultaneous save state.
- Unconfirmed remains uncertainty; matching observed bytes cannot confirm an
  earlier operation. Failed status must not force definite-failure UI copy.
- Input changes block adoption, not current readability results. Publication
  settlement invalidates older reads. Refresh uses the same guarded path and
  completes after a requested fresh pass, without initiating saves or adopting
  over pending/failed input. Zero-subscriber refresh attaches no permanent watcher.
  Current means no settlement since the read began. Subscribed settlement
  schedules a guarded reread; dormant settlement does no automatic read.
- The first subscriber watches before rereading; the last unsubscribe detaches
  observation only. Acquisition's temporary watcher is released before return.

## Evidence and concrete challenges

Read the current implementation and callers, including uncommitted source:

```text
packages/folder/
|-- README.md
`-- src/{table,editor,canonical,row-text,storage}.ts
packages/svelte/src/from-subscription.svelte.ts
packages/auth/src/svelte/auth.svelte.ts
apps/todos/src/
|-- lib/{todos,todo-editor}.svelte.ts
`-- routes/components/{TodoDetail,TodoStatus}.svelte
apps/honeycrisp/src/lib/{notes,row-session,file-session}.svelte.ts
apps/capture/src/lib/{captures,draft}.svelte.ts
apps/whispering/src/lib/library.svelte.ts
apps/vocab/src/lib/word.svelte.ts
docs/adr/{0465,0471,0483,0485,0503,0504}-*.md
```

Return an ASCII files-read tree followed by concrete corrections or a supported
no-blocker verdict. Preserve disagreement and distinguish inspection from runtime
proof. Stop once the focused question has a defensible answer.

Trace at least these sequences:

- A publishes while B is accepted; B is public before its write; A's receipt
  cannot roll the public row back or mix A's text with B's fields.
- A fails with B pending; refresh reads C; B and the failure survive; valid or
  invalid projection uses B, never half B and half C.
- Input changes during read; availability still changes, adoption does not.
- Read failure hides both live views; acceptance while unreadable stays private;
  restored readability exposes the correct current snapshot.
- App draft is newer than submitted input; it survives conditional removal and
  owns its own repair. No component substitutes older core text for that draft.
- Actual Svelte getter/setter bindings read the newest readable row snapshot,
  narrow unreadable during teardown, and never submit a fallback empty string.
- Immediate close after a setter sees all admitted work as saving. Failed,
  unreadable input remains retained without a public text accessor.
- Failed NotFound B, explicit file recreation C, refresh: B becomes public,
  failure remains, and C is not adopted. Dropping and reacquiring the settled
  owner is deliberate discard, not hidden failed-input adoption.

The earlier independent Codex and Opus passes reviewed the preceding standalone
text/value surface. This is an informed follow-up against the revised user
contract, not another blind discovery pass. Codec tests passed and binding
snippets compiled; queue, mounted UI, and native lifetime evidence remain unbuilt.
