# Editor simplification and app acceptance

Completed 2026-10-06. All five coordinated chats finished; the coordination
heartbeat is paused. Accepted source changes are committed. Unrelated dirty
files and the pre-existing staged device owner change remain intact.

## Current editor pattern

```text
Current editor row
|-- valid   -> structured controls
`-- invalid -> exact source text for repair

Control getter -> current owner value
Control setter -> compose complete current input -> editor.set
Source setter  -> editor.setText
Editor         -> accepted input + publication queue
Rich session   -> selection + undo + Markdown conversion
```

The default needs one validity branch and no view-selection state. Apps that
offer meaningful alternative views retain one selection owner. Tabs own active
panel mounting. Shared Input and Textarea retire destroyed value bindings;
command controls retain their own lifetime checks. Setters still check current
admission because eligibility can change after rendering.

Capture composes `{ text, thoughts: string[] }` through its body codec. Thought
positions identify visible entries. The codec preserves surrounding Markdown
and writes a consistent Thoughts section without per-thought provenance.

Refused input, unfinished drafts, outside-file conflicts, publication uncertainty
and rich undo retain separate owners because they hold different information.
Their protections were not removed to reduce state counts.

## Commits

| Repository | Commit | Result |
| --- | --- | --- |
| Epicenter | 85995cbc7b | Compose editor input, consolidate view ownership and document the pattern |
| Epicenter | 25ec9b142e | Document the default single validity branch |
| Epicenter | 061234e21c | Remove duplicate Vocab value-binding lifetime guards |
| Epicenter | f8c2f7235a | Remove Honeycrisp's redundant Source lifetime wrapper |
| Epicenter | bca127432c | Remove unreachable Whispering panel notices and unused filename mode |
| Epicenter | bb0c29787b | Inline Vocab's stateless note and repair field components |
| Epicenter | 94b8698aa2 | Keep Todos completion tied to the owner after refusal; inline forwarding handlers |
| Zhongwen | e24826c | Adapt learner/repair flows to current Folder APIs and restore tagged-entry repair access |
| Zhongwen | 64a85e8 | Clarify selected-expression save, uncertainty and duplicate-retry feedback |

## Verification and limits

The coordinator reproduced 12 Honeycrisp, 13 Whispering, 20 Vocab and 13 Todos
mounted cases for their accepted changes, plus 46 Zhongwen mounted cases and
29 Zhongwen learner/practice cases. Relevant app typechecks/builds passed as
recorded in the campaign evidence. These are scoped runs across the campaign,
not a claim that the entire dirty monorepo passed at one final revision.

Actual browser journeys covered source repair, item isolation, note/stage
persistence, rich/source/undo transitions, refused completion and retry behavior.
The Todos regression failed before its binding correction and passed afterward.
Read-only shared reviews found no justified queue or editor redesign.

Vocab inference and Whispering real transcription lack configured providers.
Current native runtime/hardware, physical touch/IME and tutoring quality remain
unaccepted. Vocab malformed-source repair has mounted coverage rather than an
actual owned browser fixture. Zhongwen downloaded-byte comparison remains open.
