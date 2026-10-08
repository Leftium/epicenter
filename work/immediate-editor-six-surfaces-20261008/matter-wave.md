# Matter immediate body wave

Baseline: be0f093763. Worker clone: /tmp/matter-immediate-owner-20261008,
dependencies installed frozen. No transferred dirty source.

Files read before analysis:

```text
apps/matter/
|-- README.md, package.json, vite.config.ts, vite.e2e.config.ts
|-- playwright.config.ts, e2e/grid.e2e.ts
|-- src/lib/
|   |-- table.svelte.ts, vault.svelte.ts
|   |-- components/{MarkdownBodyEditor,RowDetailDialog,TableGrid}.svelte
|   `-- e2e/install-mocks.ts
|-- src/routes/(vaults)/vault/[id]/{TablePane,VaultShell}.svelte
`-- src-tauri/{tauri.conf.json,src/entry.rs}
packages/matter-core/src/core/{parse,serialize}.ts
apps/skills/{README.md,src/lib/components/editor/CodeMirrorEditor.svelte}
```

Independent GPT 6.1 and Opus reviews support table-owned accepted body input,
separate from the disk projection. A widget-only owner loses text on failed
publication followed by dialog teardown. Keep accepted input authoritative
until explicit reload, and show external changes before the next replacement.
A recovery surface must expose retained input when row conformance disappears.
Table lifetime covers dialog close and table switching, not vault disposal or
app restart. No broader lifetime promise is accepted in this wave.

Native write limit: read_entry and write_entry are separate calls. The JS owner
can refuse missing/malformed bytes observed at read time; removal or outside
changes after that read can still race atomic rename. Do not claim an atomic
conditional write without a native protocol change.

Skills computer-use acceptance at localhost:25861 still shows Could not open
Skills, with the existing no-account explanation. Typecheck passed with zero
errors and warnings. Its signed-in editor remains unverified, with no auth bypass.

Matter native dev build succeeded, but the app automation selected the installed
Matter app (tauri://localhost, old sample path), not this checkout's unbundled
debug process. No user data was edited in that window. Packaging this checkout
under a distinct acceptance name is the next native access attempt.

Browser fixture baseline: localhost:25860/vault/e2e-vault uses the repository's
existing mocked Tauri adapter. Opened card-a.md and typed Baseline body edit.
This exercises actual components with mocked IPC, not native persistence.


Review of the worker's partial diff (not yet accepted):

- The new retained body owner and immediate widget updates match the direction.
- The partial recovery list only includes failed saves. A retained body whose
  previously saved file later disappears also needs an accessible recovery path.
- Retirement must stop new body writes through retained controls after disposal.
- External-change copy should say the next edit replaces the disk version.
- UI retention promises must say while the table/vault remains open.
- The proposed reload currently drops the accepted value onto the watcher
  projection. Either name this as discard or make reload read fresh bytes.
- Preserve a body's previous failure reason while a newer save runs.

These are bounded acceptance corrections, not a reason for another review panel.
Final worker source may already address them. Verify before editing.


Native baseline reproduced on this checkout's distinct Matter Acceptance app
(bundle built at be0f093763): opened only the disposable copied sample vault
/private/tmp/matter-owner-acceptance-vault-20261008. The first picker interaction
briefly opened Documents without adopting or editing it; no user file changed.
Corrected picker navigation via Go To field, then opened the disposable vault.
Removed directory owner-write permission temporarily, opened quick-thought.md,
typed Native refused-save acceptance., blurred and closed. The table showed
Couldn't save: Permission denied (os error 13). Reopening the same note showed
only its original body; the typed paragraph was gone. Directory owner-write
permission was restored immediately. This is actual native failure/reopen
evidence for the missing accepted-content owner, not just mocked IPC.


Final files read before integration review (in addition to the baseline tree):

```text
apps/matter/
|-- README.md, package.json, playwright.config.ts, e2e/grid.e2e.ts
`-- src/
    |-- lib/
    |   |-- table.svelte.ts, svelte-dom.test-support.ts
    |   `-- components/{MarkdownBodyEditor,BodyStatus,RowDetailDialog,TableGrid}.svelte
    `-- routes/(vaults)/vault/[id]/
        |-- TablePane.svelte, TablePane.mounted.test.ts
        `-- fixtures/TablePaneHost.svelte
docs/adr/0507-editor-views-compose-current-input-and-own-only-interaction-state.md
```

Completed worker f09de32e-22ee-4712-a064-d81cfa783d2e returned is_error=false.
It reported six mounted tests, 41 unit tests, clean typecheck/build and a useful
mutation check. Six shell permission denials limited ancillary investigation,
debug logging and browser-server startup. None authorized a wider retry. Codex
reviewed the source and ran the integrated checks separately.

Adjudication and corrections:

- Keep table-owned accepted input: the native baseline proved widget lifetime
  alone loses typed content after a failed save and dialog close.
- Keep the disk projection separate. Retain accepted text until explicit discard;
  neither a save completion nor an unversioned stale watcher echo replaces it.
- Rename reload to discard: it drops input onto the last observed file version,
  and does not promise a fresh read. The button says Discard my text.
- Show the recovery list for retained bodies differing from disk as well as
  failures, covering a previously saved file that later disappears.
- Retire body set/retry/discard after table disposal; do not enqueue a later
  coalesced save after disposal. Already admitted writes can finish.
- Preserve the previous failure reason while another save runs.
- Warn that the next edit replaces a differing observed file body. Watcher
  echoes can cause a temporary difference notice; do not label it definitely
  another writer's change.
- Use a function binding for the widget body instead of body/onChange props.
  CodeMirror retains real document/selection/history; setState for an outside
  replacement does not publish that replacement back.
- Keep BodyStatus: it owns the same status-to-actions rule at two real call sites.
  Keep per-file serialization: field writes and body writes share it to avoid
  dropping one another's frontmatter/body changes. No generic editor framework
  or global registry was introduced.

Codex verification: 41 unit tests, eight mounted tests, zero typecheck errors or
warnings, production/native bundle build passed. Mounted tests emit derived_inert
on dialog teardown, so this is not a warning-free mounted claim. The new browser
keyboard test first failed because Close also matched Close vault; the locator
was made exact and rerun. The native journey below is independent evidence.

Native integrated acceptance in Matter Acceptance, disposable vault only:

1. Removed directory owner-write permission, typed Native retained-body
   acceptance. The reason Permission denied appeared while the widget stayed
   focused; no blur was needed to attempt the save.
2. Closed and reopened quick-thought.md. The paragraph remained, with retry and
   discard controls. Disk bytes were still unchanged.
3. Restored directory owner-write permission immediately. Try again saved the
   complete paragraph, preserving title/status/featured frontmatter. Verified
   actual file bytes.
4. Replaced the disposable file's body externally. The widget kept accepted text
   and warned that the next edit replaces the observed file body.
5. Discard my text showed Native external body acceptance. without publishing
   the old accepted text back.

Limits: retention ends on table/vault disposal or app quit. JS read/write calls
are not a native conditional transaction. Skills remains no-account blocked;
Capture's multiline form choice is pending and the existing form remains.

Final new browser keyboard test: one passed. Matter implementation commit: `2fb429d323`.
