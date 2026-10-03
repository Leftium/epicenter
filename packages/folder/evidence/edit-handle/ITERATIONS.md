# Edit handle review evidence

This experiment continues thread `01a10008-a12f-7b11-ada9-44a1bcb77278`.
It modifies disposable demo data. It does not migrate production callers.

## The boundary that survived review

A retained edit owns one file's draft, displayed baseline, observations, and
admitted save. A form's controls share that edit explicitly. Frameworks own
their subscriptions; the app owns draft retention and save timing.

An independent immediate action patches the displayed source and conditionally
writes against that same capture. It acquires no edit lifecycle. The app owns
pending admission and the chosen checkbox value across rerenders.

The original Todos toggle joins a retained editor when one exists. Otherwise
it patches the current file through `table.update`. The demo's independent
command deliberately has different behavior. Production migration must settle
that app policy rather than replacing every toggle mechanically.

## Wave 1: implementation and counterexamples

Claude implemented in an independent clone. Independent Codex and Claude
reviews traced the real callers. Computer use exercised the three framework
views against a disposable native folder through the demo HTTP transport.

The browser demonstrated duplicate checkbox admission after a file hint,
missing files misreported as unreadable, and receipt wording that claimed a
historical version was still current. The reviewers also reproduced writes
redirected by another path's reviewed snapshot, reentrant disposal returning
before admitted work, and a saved lone surrogate remaining dirty.

The initial 17 tests passed despite those defects.

## Wave 2: repairs and another challenge

The coordinator reproduced 25 passing tests with 130 assertions, a full Vite
build, zero Svelte/Solid diagnostics, and a passing folder typecheck. Matching
the demo's Node types to the repository fixed the introduced typecheck failure.

Browser retesting confirmed pending checkbox protection, rejected control
values restored in all three frameworks, distinct missing and unreadable
states, newer typing retained across a held reply, historical receipt wording,
and drafts retained across control remounts.

A fresh reviewer pair retained the API and challenged separate uncertainty
recovery. The tracker did not cancel or fence an unknown write. It automatically
adopted an earlier attempted version as the baseline, but required special
discard refusal and resolution rules. The missing-file case exposed a UI route
with no discard action; the engine itself still allowed explicit baseline
resolution.

We accepted deleting that recovery protocol. A lost reply remains historical
`lastSave` information. Subsequent versions follow ordinary observation rules.
The cost is explicit review when an earlier unknown attempt appears while newer
typing remains dirty. Discard remains refused while a save is admitted.

## Wave 3: accepted

The coordinator reproduced 31 passing tests with 161 assertions, the full Vite
build, zero framework diagnostics, the folder typecheck, and Biome checks.
The tests include ordinary failure, conflict, and lost-reply autosave pauses.

Computer use held B's reply, typed C, unmounted all three views, and released B.
C published once while the views were absent. Remounting showed C everywhere.
Typing, rereads, hints, and remounts did not restart paused autosave. Resume
respected incoming review; reviewed resolution then published once.

An unknown result preserved newer C and presented earlier B for ordinary
review. Discard worked after uncertainty with a missing file, preserving the
missing observation and historical unknown result. Admitted saves still
refused discard. Late writes after discard adopted cleanly without preparing
an undo.

The final review kept the autosave lifetime and contracted its notification
API. The coordinator replaced its listener registry and getters with one
pause-change callback. The helper returns only `start`, `stop`, and `resume`.
The edit handle remains the sole framework store. Tests and focused browser
retesting passed after this contraction.

The final Codex pass was an informed follow-up; the final Claude review began
in a fresh session and then challenged the callback contraction. Both found
no correctness blocker or further grounded API change for these callers.
We stopped after the intended journeys passed, rather than claiming that no
better design could exist.

## Limits

The native folder's hash check is best effort against outside writers. The
other writer uses `node:fs`; the harness explicitly supplies its change hint.
Lost replies are simulated. Browser observations do not establish a stronger
native concurrency guarantee or production migration readiness.
