## Verdict: accept, no blockers

I read the current source for all seven repairs plus `repair-wave-report.md`, `repair-delta.patch` and `honeycrisp-baseline.md`; I ran nothing. Acceptance still depends on your pending typecheck and CUA reruns, because the worker report says nothing was rendered.

## Repairs against the earlier guarantees

- **Duplicate-diagnostic filter, four banners** (`TodoDetail.svelte:76`, `NoteDetail.svelte:112`, `RecordingDetail.svelte:120`, `TransformationDetail.svelte:131`): this is the same inline condition `CaptureDetail.svelte:251` already uses, with no helper. Real YAML line diagnostics differ from the summary, so they still show.
- **Edit Source button** (`TodoDetail.svelte:70-72` and the three siblings): it sets the existing `tab` state from a click only. No effect or observer selects Source, so an outside edit adopted mid-session cannot move the person's tab. It is hidden while Source shows.
- **"Saved as written" removed:** the banner now describes how the text reads and leaves saving to `SaveStatus` / `DraftStatus`. Raw saving itself is untouched.
- **`reading.ts:28-30` doc:** it states the fallback and the display rule. `parseError()` and the non-empty tuple are unchanged, so `note-source.ts:45` and the `diagnostics[0]` tests keep working.
- **Push translation** (`browser-backend.ts:514-538`): narrow and at the right owner.
  - It matches by class and `data.reason`, not by message text.
  - It keeps the original as `cause`.
  - It rethrows everything else untouched (`tag-exists`, network, auth, and the server-result path at `:539-543`).
  - `git.push` and `git.Errors` come from the same namespace import, so `instanceof` cannot miss on a duplicate module copy.
  - The new text states the failure without advice. Todos still appends "Local commits are kept." (`status.ts:235`).
- **Backend translation versus app-side hiding:** the backend translation is the right choice. Hiding in the app would need string matching or would drop auth and network detail a person needs.
- **RichEditor `{:else if}`** (`RichEditor.svelte:336`): same owner, using the `inspect` prop it already had. The component, both effects and the `editable` boolean are untouched, so the mount lifetime and undo history behave as in the baseline. A malformed note now shows its sentence once instead of three times, and the incorrect "would change or drop" claim no longer appears for a parse failure. The HTML fallback for a valid note is unchanged.

## Residual items, none blocking

- **No test pins the new push message.** The existing divergence test asserts only `status === 'failed'`, and `status.test.ts` still has no unobserved-divergence case. One assertion beside the existing one in `native.test.ts` would close it.
- **Native and desktop push refusals keep git's own text.** The report says so; it is outside this repair.
- **A malformed Honeycrisp note on the Rich tab now shows an empty pane under the banner.** The banner button is the only action. Worth a look in the CUA rerun, but it is a reasonable outcome.
- **`richAvailability` still builds `reasons` from parse diagnostics** (`note-source.ts:45`), and nothing renders them for the unparsed case now. They still drive `editable`, so this is harmless. I would not touch it in this wave.

## Further collapse

None grounded by these repairs. The earlier open items stand as product decisions: KV upsert, the table-as-reader alternative, and a typed push rejection.