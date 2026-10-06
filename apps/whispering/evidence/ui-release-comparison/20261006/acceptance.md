# Recording-list iteration

Date: 2026-10-06. Objective: identify and find recordings in compact windows and
in the list beside an open recording, without opening each file for its date.

## Baseline and evidence

Compared the installed `/Applications/Whispering.app` through native computer use
with `apps/whispering`. The reference's recording table extends beyond its compact
window: transcript, audio and actions compete for horizontal space. No reference
recordings, provider credentials or transcript contents were transferred to Claude.

The local baseline at 390x700 gave its fixed Status column 160px. Alongside a
Fixture badge, `Morning planning` truncated and its excerpt showed only a few
words. Date and duration disappeared. `recordings-before.jpg` captures this.

Claude's standalone clone is `/tmp/whispering-ui-wave-20261006`, based on
`d04bbbb93686d4b50aeb2a474c4519f7013a4863` with working source copied in.
`worker-baseline.json` in that clone records transferred paths. The original
RecordingList SHA-256 is
`1833d15095f83407bbe6c8390bf4ca6350035c6470bfeeb95b4aa62f67b4e474`.
Only RecordingList.svelte is this task's production edit. Other checkout changes
were preserved. Before each integration, its live contents matched the worker's
input version.

Initial UI evidence used the live dev server. Other work and generated-file sync
triggered reloads, so final acceptance served the isolated clone at the same
`http://127.0.0.1:1441` origin. Its final RecordingList exactly matches the live
integrated file, SHA-256
`6633cb54a7b13d43ec852e67632103f873b085da09fc3809756167ee45ebf882`.

Data is disposable: one generated-tone capture renamed Morning planning, one
synthetic Evening review row naming that audio, and one synthetic transcript.
Files were created through the app's terminal. No provider was called. The first
transcript fixture used an invalid instant spelling; it was repaired through the
terminal before final detail acceptance. The second row's duration is synthetic.

## Accepted waves

1. Below a 768px list-container width, date, duration and status move under the
   title. Transcript excerpts show up to two lines. Wide lists keep their columns.
   One table, one row tree and existing checkbox actions remain. The redundant
   No transcript yet placeholder disappears because status already says it.
2. Review found hiding columns also removed sort controls. A shared Select now
   exposes all eight orders and displays the session's actual current order in
   compact lists. Wide headers and Select write the same recordingSort. At 576px,
   three header controls squeezed the count; search now stays on its own line
   until the same 768px threshold. This final CSS correction was made by Codex.

Claude Code used claude-opus-5-5, session
`31252379-d5ed-47f2-a0cd-f9b52e9f27ee`. Worker typecheck and build passed. Worker
tests could not run because nested sandboxed commands could not find Bun; first
wave attempts to repair PATH or invoke mounted tests were denied. Codex ran the
checks separately without widening the worker's boundary.

## Computer-use acceptance

- At 390x700, title, two-line excerpt, status, date and duration are readable.
- At 576x700 and 690x576, the corrected header and rows fit without horizontal
  page overflow. The search field remains full-width in compact lists.
- At 1200x800, all four sortable columns appear and compact metadata is hidden.
  Opening a recording narrows the list to 42%; compact rows and Select appear
  from container width, despite the wide window.
- Wide Length sorting followed by opening details shows Longest first in the
  compact Select, with the same row order.
- Keyboard Enter opens Select; ArrowDown and Enter choose Oldest first, reorder
  rows and leave focus on Sort recordings. All eight choices were exercised
  against the two distinct fixtures and matched their expected order.
- Oldest first survives Home navigation and return to Recordings.
- Selecting a row, filtering it out, and clearing the filter keeps selection.
  The hidden-selection message is explicit and bulk actions are disabled while
  no selected row is shown. No bulk provider or delete operation was invoked.
- Closing details returns focus to the recording's row button.
- Fixture files survive reload. Saved synthetic transcript opens in the editor.

## Post-implementation review

Files read in caller context:

```text
apps/whispering/
|-- README.md
`-- src/
    |-- lib/
    |   |-- definition.ts
    |   |-- recording-collection.ts
    |   `-- session.svelte.ts
    `-- routes/
        |-- recordings/+page.svelte
        `-- components/
            |-- AppShell.svelte
            |-- FileView.svelte
            |-- RecordingDetail.svelte
            |-- RecordingList.svelte
            `-- file-actions.ts
packages/ui/
|-- README.md
`-- src/
    |-- select/select-trigger.svelte
    |-- select/select-item.svelte
    |-- table/table.svelte
    `-- table/table-cell.svelte
```

The collection still owns filtering, sort comparison and selected-row policy.
The session still owns search, selection and order. The component owns only
presentation. Shared Select owns keyboard and focus mechanics. No viewport state,
alternate row implementation, persistence owner or component API was introduced.
Header widths now live beside column definitions instead of in a nested ternary.
One container threshold replaces staggered column visibility. Duplicate status
rendering is intentional responsive presentation; only one is visible.

## Limits

Codex reproduced typecheck with zero errors and warnings, production build,
`check:ui-boundary`, and the app's complete test script: 456 library tests plus
10 mounted-view tests, zero failures. The test script was repeated after the
sort correction. The final search-width class was changed during that run;
its layout was verified in computer use, and production build was repeated
after it. No new tests were added for this presentation-only change.

Final changed UI acceptance is browser evidence. This task did not rebuild or
exercise the new native shell, microphone hardware, paid endpoints, or failure
injection. Repair, failed, unsaved and running row tones were checked in source;
only transcribed and untranscribed states were exercised in this wave. The desktop
reference was inspected read-only. No native feature parity is claimed.
