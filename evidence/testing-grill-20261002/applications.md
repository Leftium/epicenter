# Partition 3 testing grill

All 115 assigned test files were fully read, including 15 transferred files. The read-only consultations account for every declaration and expanded parameterized case. Production-read limitations are stated in the preserved consultation evidence; Codex independently verified every accepted deletion and behavioral change against current source. Unverified or uncertain deletion candidates were retained.



Counts are declarations, with expanded cases after a slash. "Keep" means every case names a reachable regression and nothing should change beyond items already listed above.

### apps/capture
- `apps/capture/src/lib/captures.test.ts`: 25/30. Keep. Real folder plus real draft module over create, outside-edit, removed vs unreadable, write-back races, copy, close-drain. "a failed explicit commit…" echoes a stubbed `commit` through a pass-through, but pins the save/commit separation; keep. JSDoc omits the five close/settle cases.
- `apps/capture/src/lib/draft.test.ts`: 17/21. Keep. The fake store does conditional writes and held gates, so each race is reachable. Overlap with `captures.test.ts` is controlled ordering vs real folder.
- `apps/capture/src/lib/platform-selection.test.ts`: 2. Keep. Bundle-graph check of a seam that falls back silently.
- `apps/capture/src/lib/platform/folder.epicenter-host.test.ts`: 15/18. Keep. Real adapter over scripted IPC; pins `attach` args, change scoping, lost-reply reconciliation, idempotent import.
- `apps/capture/src/lib/platform/shell-lifetime.test.ts`: 5. Keep.

### apps/epicenter
- `apps/epicenter/scripts/build-applications.test.ts`: 1 per compiled app (4). Keep. Only check that runs each real build and its base path.
- `apps/epicenter/scripts/build-sidecar.test.ts`: 1. Keep. Compiled binary without Bun on PATH, port contract, EOF exit.
- `apps/epicenter/src/account-transport.test.ts`: 13. Keep. Real loopback relay: credential stripping, replay, retirement, cancellation, successor fencing, blob copy claims.
- `apps/epicenter/src/ai-catalog-routes.test.ts`: 3. Keep. Test 2's name joins two unrelated behaviours.
- `apps/epicenter/src/ai-catalog.test.ts`: 17. Keep. Each maps to a branch in `ai-catalog.ts` (queueing, access-version abort, secret erase, dir-sync, prefix escape).
- `apps/epicenter/src/app-installation.test.ts`: 8. Keep; fix S1. "refuses reserved ids" rewrites an identical manifest (dead setup).
- `apps/epicenter/src/capture-application.test.ts`: 2. Keep. Route id, CSP `ipc:`, reserved ids derived from `BUILT_IN_ROUTES`/`APPS`.
- `apps/epicenter/src/checkout.test.ts`: 15. Keep 14; D10.
- `apps/epicenter/src/desktop-auth-authority.test.ts`: 28/37. Keep. Ordering and fencing races with held gates; production not read.
- `apps/epicenter/src/device.test.ts`: 8. See D8. Keep "a failed physical open can be retried…" (not in `owner.test.ts`) and the account-path case; retitle the file as a fixture test.
- `apps/epicenter/src/host.test.ts`: 15. Keep. Approval gate, direct invocation, dispose, ring eviction, `parseHomeCommand` validation.
- `apps/epicenter/src/mail-authorization.test.ts`: 2. Keep test 1; D1.
- `apps/epicenter/src/server.test.ts`: 43/45. Keep all. S1, S5, S7 and the JSDoc contradiction apply. At 2,730 lines it exceeds the split threshold; `loadStaticAssets` and the sidecar smoke are natural splits.
- `apps/epicenter/src/sidecar-runtime.test.ts`: 29. Keep 28; D3.
- `apps/epicenter/src/static-assets.test.ts`: 2. Keep the installed-bundle composition test; D7. Test 1 leaks its temp dir.

### apps/local-books
- `apps/local-books/src/books/query.test.ts`: 3. Keep. "rejects a write" accepts any error and does not check the row survived.
- `apps/local-books/src/books/recategorize.test.ts`: 5. Keep.
- `apps/local-books/src/books/report.test.ts`: 1. Keep.
- `apps/local-books/src/books/status.test.ts`: 4. Keep.
- `apps/local-books/src/db-file.test.ts`: 15. Keep.
- `apps/local-books/src/token-store.test.ts`: 9. Keep.
- `apps/local-books/test/app-api.test.ts`: 12. Keep.
- `apps/local-books/test/books-cli.test.ts`: 3. Keep.
- `apps/local-books/test/cli-e2e.test.ts`: 1. Keep.
- `apps/local-books/test/db.test.ts`: 8. Keep. Monotonic ingest and cursor atomicity.
- `apps/local-books/test/entities.test.ts`: 7. Keep. Pins QuickBooks JSON paths.
- `apps/local-books/test/env-example.test.ts`: 1. Keep.
- `apps/local-books/test/grill-e2e.test.ts`: 1. Keep. `seedTokenFile`/`runCli` are copied across three files and could move to `helpers.ts`.
- `apps/local-books/test/mcp-server.test.ts`: 2. Keep.
- `apps/local-books/test/mode.test.ts`: 7. Keep 6; D2.
- `apps/local-books/test/oauth.test.ts`: 5. Keep. Shared `beforeAll` server makes `hits.token >= 1` order-dependent.
- `apps/local-books/test/sync.test.ts`: 10. Keep.
- `apps/local-books/test/token-manager.test.ts`: 2. Keep; test 2 is the control for test 1.
- `apps/local-books/test/tokens.test.ts`: 7. Keep.

### apps/local-mail
- `apps/local-mail/src/accounts.test.ts`: 6. Keep.
- `apps/local-mail/src/gmail-client.test.ts`: 5/11. Keep; S8.
- `apps/local-mail/src/intent-store.test.ts`: 3. Keep.
- `apps/local-mail/src/mailbox.storage.test.ts`: 3. Keep.
- `apps/local-mail/src/mailbox.test.ts`: 8. Keep. Two cases ("an older delivery cannot retire a newer assertion", "the revision stays monotonic…") test the intent store and belong in `intent-store.test.ts`; each has an assertion the tests there lack.
- `apps/local-mail/src/message-fields.test.ts`: 11. Keep; S3.
- `apps/local-mail/src/oauth.test.ts`: 6. Keep.
- `apps/local-mail/src/outbox.test.ts`: 11. Keep.
- `apps/local-mail/src/reconcile-now.test.ts`: 12/18. Keep, including the seven microtask-offset cases (a regression sweep of one race window); S1.
- `apps/local-mail/src/reconcile.test.ts`: 16. Keep; fix JSDoc. `onWrite: () => undefined` in "restoring from trash…" is dead.
- `apps/local-mail/src/storage.test.ts`: 8. Keep; S1.
- `apps/local-mail/src/sync.pass.test.ts`: 24. Keep. JSDoc omits the whole-mailbox and `CacheBusy` groups.
- `apps/local-mail/src/sync.resume.test.ts`: 7/8. Keep.
- `apps/local-mail/src/token-manager.test.ts`: 13/15. Keep; mixed Result style.
- `apps/local-mail/ui/src/lib/actions.test.ts`: 7. Keep; S9.
- `apps/local-mail/ui/src/lib/data.test.ts`: 3. Keep.
- `apps/local-mail/ui/src/lib/mail.test.ts`: 8. Keep.
- `apps/local-mail/ui/src/lib/platform-selection.test.ts`: 2. Keep test 1. Test 2 greps source text for an identifier, which a comment would satisfy; capture's bundle-graph approach is stronger. D14.
- `apps/local-mail/ui/src/lib/sanitize-email.test.ts`: 7. Keep. `beforeAll` is justified by DOMPurify's load order.

### apps/reddit, apps/self-host, apps/skills
- `apps/reddit/src/lib/workspace/ingest/reddit/index.test.ts`: 3. Keep.
- `apps/reddit/src/lib/workspace/ingest/reddit/parse.test.ts`: 5. Keep.
- `apps/self-host/data-root-owner.test.ts`: 1. Keep.
- `apps/self-host/local-lifecycle.test.ts`: 1. Keep. It also launches Chromium to play a WAV, which the name omits and which makes failures hard to locate; it imports a fixture from `packages/server/evidence/`.
- `apps/self-host/runtime-profile.test.ts`: 7. Keep 6; D6.
- `apps/self-host/shutdown.test.ts`: 1. Keep.
- `apps/self-host/trusted-origins.test.ts`: 5/17. Keep. Each refusal is a distinct way to widen CORS.
- `apps/skills/src/lib/application.test.ts`: 5. Keep. JSDoc states what it does not prove.

### apps/whispering
- `apps/whispering/native/audio.test.ts`: 7. Keep.
- `apps/whispering/native/close.test.ts`: 8. Keep 7; D11.
- `apps/whispering/native/failure-injection.test.ts`: 13. Keep. AGENTS requires injection to behave as a careful outside program.
- `apps/whispering/native/host.test.ts`: 20. Keep; S6. The 20-path list in "a path that cannot be read…" repeats `audio.test.ts`; one path per error class would keep the "sends nothing" promise.
- `apps/whispering/src/lib/definition.test.ts`: 2. Keep. Table and field names are the on-disk layout.
- `apps/whispering/src/lib/editor.test.ts`: 4/6. Keep.
- `apps/whispering/src/lib/formats.test.ts`: 9. Keep.
- `apps/whispering/src/lib/leave.test.ts`: 14. Keep.
- `apps/whispering/src/lib/library.test.ts`: 48. Keep. Lines 992-1016 inline the same setup as `publishedButUnshown()` at 1041-1068; use the helper. At 1,854 lines it exceeds the split threshold. JSDoc omits the published-but-unshown and quit-preparation groups.
- `apps/whispering/src/lib/page-boundary.test.ts`: 8. Keep. AGENTS says not to weaken it.
- `apps/whispering/src/lib/recordings/publish.test.ts`: 18. Keep.
- `apps/whispering/src/lib/session.test.ts`: 12/13. Keep 12 cases; D12.
- `apps/whispering/src/lib/transformation.test.ts`: 8/16. Keep.
- `apps/whispering/src/lib/transformations.test.ts`: 29/35. Keep. The seven "differs only in <field>" cases each guard one field of the snapshot comparison. The editor-conflict cases repeat `library.test.ts` on the transformation selection; I did not read `library.svelte.ts` to confirm the wiring differs, so I leave them. Line 605 accepts two messages, a hedge on a real race; the `transformed` length 0 assertion carries the test.
- `apps/whispering/src/lib/workspace/desktop.test.ts`: 22. Keep; S4. Three 650 ms sleeps wait on the reconnect delay.

### packages and scripts
- `packages/agent/src/compose-tool-catalogs.test.ts`: 4. Keep.
- `packages/agent/src/local-tool-catalog.test.ts`: 4. Keep.
- `packages/agent/src/loop.test.ts`: 12. Keep 11; S2.
- `packages/agent/src/namespace-tool-catalog.test.ts`: 3. Keep.
- `packages/agent/src/tools.test.ts`: 5. Keep.
- `packages/app-shell/src/boot-screens/open-failure.test.ts`: 8. Keep. The `ClaimFailed` row guards the regression noted in `open-failure.ts` (ADR-0344).
- `packages/app-shell/src/inference-picker/catalog.test.ts`: 13. Keep. Six tests never call `close()`; `$state` is set globally and not restored.
- `packages/app-shell/src/inference-selections.test.ts`: 5. Keep.
- `packages/blobs/src/app.test.ts`: 7. Keep 6; D13.
- `packages/blobs/src/blob-format.test.ts`: 5/30. Keep. The extension is part of the durable key.
- `packages/blobs/src/blob-id.test.ts`: 2. Keep.
- `packages/blobs/src/browser-lifecycle.test.ts`: 10. Keep 9; D5; fix JSDoc.
- `packages/blobs/src/browser.test.ts`: 13. Keep. "each app has independent keys while browser sources own disposable URLs" repeats two lifecycle tests apart from the `blob.type` passed to `createObjectUrl`; move that assertion if you want to drop it.
- `packages/blobs/src/bun.test.ts`: 18/24. Keep 23 cases; D4. The six retry-loop cases overlap tests 10 and 11, but each has a unique assertion (same consumed `Request`; receipt file count).
- `packages/blobs/src/webview.test.ts`: 7. Keep. Pins the `BLOB_PATHS` literal.
- `packages/skills/src/skills.test.ts`: 3. Keep; S10.
- `packages/sync/src/auth-subprotocol.test.ts`: 3. Keep. The JSDoc bullet "prefix comes from the shared constants package" is asserted nowhere here.
- `packages/sync/src/current-download.test.ts`: 5. Keep.
- `scripts/epicenter.test.ts`: 18/35. Keep 30 cases; D9.

## Transferred 15 file verdicts



Counts are declarations, with expanded cases after a slash.

- `packages/app/src/import-boundaries.test.ts`: 4/15 (declaration without globals ×2, ten entrypoint bundles, memory runtime without globals ×2, foreign IDB globals). Keep the ten bundle cases and the foreign-globals case unchanged; each entrypoint is a separate transitive-import surface. D2 and D3 apply to the two loops.
- `packages/app/src/independent-blobs.test.ts`: 2. Keep. Test 1 exercises the real `blob-owner.ts` close fan-out to recorders. Test 2 exercises the `add` error path that keeps the minted id and destination after a commit-then-throw. S3.
- `packages/app/src/independent-inference.test.ts`: 3. Keep. Credential override, destination fence, close during credential resolution, and no unauthenticated dispatch.
- `packages/app/src/independent-secrets.test.ts`: 1. Keep.
- `packages/app/src/index.test.ts`: 2. Keep both; S2. The invalid-id case hits the `isAppId` throw. The `compileData` failure branch at `index.ts:30-32` has no case here; I did not check whether another file covers it.
- `packages/app/src/open-store.test.ts`: 6. Keep. Identity capture before admission, duplicate exclusion, returned vs thrown acquisition failure, failed cleanup retaining the claim, offline reopen. The `'identity' in personal` and `'blobs' in personal` checks are absence assertions, but small.
- `packages/app/src/platform-selection.test.ts`: 1. Keep. The throwing getter is the only test that would catch a stray `isTauri()` read on the explicit-runtime path.
- `packages/app/src/recording.test.ts`: 7. Keep 6; D1. The retained cases reach production through the assertUsable fence, the close promise waiting on `owner.close()`, `write` bypassing the public fence, and the sync-throw conversion in `createRecorder.close`. The `cancels()` counts come from the fake's own close logic, so they prove only that close was invoked.
- `packages/app/src/runtime-transcriber.test.ts`: 11. Keep. "unsupported hints remain unapplied" echoes the fake's `applied`, but guards against deriving it from the request.
- `packages/app/src/runtime.test.ts`: 2. Keep. The cleanup-failure case overlaps `open-store.test.ts` "failed Personal cleanup…", which is the Personal store; this is Local and also pins a single cleanup attempt.
- `packages/app/src/store-blobs.test.ts`: 6/7 (ownership and isolation, document/blob first-failure ×2, aggregate failure, thrown acquisition, cleanup rejection, abort-callback fence). Keep; S3.
- `packages/app/src/store-sqlite.test.ts`: 5. Keep. Test 1 packs account isolation, identity snapshot and runtime isolation into one case; splitting would help diagnosis but loses nothing as is.
- `packages/app/src/sync-subprotocol.test.ts`: 1. Keep. Real `attachStoreSync` plus real `createSessionAuth`; the JSDoc names the regression it guards. The expected value is built from the production constants; their literals are pinned in `packages/sync/src/auth-subprotocol.test.ts` and the epicenter account-transport test.
- `packages/app/src/recording/browser.test.ts`: 18/20 (two `test.each` of 2). Keep all; S1 and the dead `navigator.locks` fake.
- `packages/app/src/recording/desktop.test.ts`: 25/34 (native error mapping ×4, concurrent current × retry 3×2, definitive stop ×2). Keep all; S4. The six concurrent-resolution cases are distinct interleavings of one race, and the four error-name mappings are a cross-boundary contract.

## Codex adjudication and implementation

# Partition 3 testing grill

Completed: all 100 original paths and 15 transferred paths received one case-by-case grill. Consultation proposals below are advisory; final adjudication at the end states the actual changes. Codex verified deciding claims and owns edits/checks. Baselines: Local Books 103/0; installation/assets 10/0; Local Mail accounts/reconcile-now 24/0; Self-host 27/0.

## `apps/epicenter/src/app-installation.test.ts`

All 8 cases retained: filesystem install/discovery, relative source paths, bundle-only updates, symlink/id validation, reserved ids, overlap, index regularity, interrupted activation recovery. Four rejection assertions must be awaited before fixture mutation/removal; validateReadyTree and readFile are asynchronous production boundaries.

## `apps/epicenter/src/capture-application.test.ts`

Both cases retained: real composed app lists and serves Capture with IPC CSP, plus reserved route/folder ids. These literals pin external URL/native ownership contracts, not mere export existence.

## `apps/epicenter/src/static-assets.test.ts`

Both cases retained: explicit compiled selection and installed+compiled resolver composition. First fixture lacks cleanup. Its only declared app cannot reveal accidental enumeration of undeclared app directories; strengthen with a real undeclared bundle.

## `apps/local-books/src/token-store.test.ts`

All 9 cases retained: permission 0600, token codec, malformed entry exclusion, connected-company selection/ambiguity/empty/override, default and overridden credential paths. resolveRealm is a wellcrafted Result<string,string>; use expectOk/expectErr rather than null-error checks.

## `apps/local-books/test/cli-e2e.test.ts`

Single end-to-end case retained: subprocess full and incremental passes produce inspectable SQLite rows/cursor and one query/one CDC hit. Unit sync tests do not replace command/config/subprocess boundary. Add leading contract documentation.

## `apps/local-books/test/env-example.test.ts`

Single drift guard retained: committed env file compared with generated names AND independent qualified literals, so same-builder tautology is avoided. Move existing documentation before imports.

## `apps/local-books/test/mode.test.ts`

Seven cases retained: force, first run, missing cursor, recent state, expired CDC, stale full backstop, missing full. First-run and missing-cursor setup are currently identical. Give missing-cursor a recent full timestamp so a cursor-guard regression cannot hide behind missing-full fallback.

## `apps/local-books/test/oauth.test.ts`

Five cases retained: real token endpoint authorization/refresh, forged state avoids network, callback-port vs public redirect, missing qualified secret. Convert Result helpers and restore undefined env by deletion rather than assigning undefined.

## `apps/local-books/test/token-manager.test.ts`

Both cases retained: provider environment refusal and matching-token acceptance. Error contract prevents production credentials receiving a sandbox refresh token. Move existing file documentation to top.

## `apps/local-books/test/tokens.test.ts`

Seven cases retained: grant timestamps, bearer validation, rotated-refresh fallback, missing access token, TTL/skew/refresh expiry. Unknown provider payload validation is not owned by typecheck. Use expectOk/expectErr.

## `apps/local-books/src/books/query.test.ts`

Three cases retained: real readonly SQLite SELECT, attempted DELETE refusal, absent mirror explanation. Genuine unsafe SQL boundary. Use Result helpers; bounded claim currently only checks untruncated two-row fixture, so do not claim row-cap coverage.

## `apps/local-books/src/books/report.test.ts`

One case retained: actual mock HTTP report hit and independent report/period outputs validate live access rather than echoed fake setup. Convert success Result assertion.

## `apps/local-books/src/books/recategorize.test.ts`

Five cases retained: Purchase and Bill required sparse fields, stale SyncToken leaves source untouched, missing mirrored transaction, read-only gate avoids update. Distinct required provider request payloads earn separate cases. Convert Result helpers.

## `apps/local-mail/src/accounts.test.ts`

Six cases retained: reconnect subject identity, secret-store refusal on put/delete, pending work blocks removal, cross-sub mailbox/intent isolation, removed-account reopening refusal. Full fake SQL/secret paths reach real branching; use Result helpers and move existing documentation ahead of support import.

## `apps/local-mail/src/reconcile-now.test.ts`

All ordinary and 7 microtask completion cases retained: gated same-account coalescing, retry after failure/reauth/throw, removal settling admitted work, completion-edge followups preserve discards. Throwing-pass rejection must be awaited before retry to exercise finally clearing activity.sync; move file documentation first and use Result helpers for removals.

## `apps/self-host/local-lifecycle.test.ts`

Single integrated subprocess/browser case retained: operator admission, passkey session, store socket ack, public/private blob bytes, real audio playback, stopped-root backup/restart persistence. Global baseline failed currentTime after a fixed 250 ms; focused whole self-host package passed 27/0. Preserve currentTime>0.1 and replace fixed sleep with bounded observed progress wait; exact load cause remains unproven.

## `packages/skills/src/skills.test.ts`

Three cases retained: historical declared schema exposes sourceId nonconformance and explicit repair, row-owned instructions survive reopen without leaking to neighbor, actual disk metadata-id/references roundtrip. Move existing documentation ahead of imports.



Final adjudication supersedes consultation suggestions: retained D2 mode with a distinct recent-full fixture; retained all uncertain boundary overlap and contractual absence checks. Deleted D1 Mail literal prefix examples, D3 duplicate sidecar literal parsing, D4 test-owned Response finalizer, and extra D1 recording fake-recovery duplicate. Real independent native URL pattern, descriptor parsing, server Response lifecycle, and recorder-owned close coverage remain. Extra import-boundary process pairs are retained because production provenance was not fully verified.

Strengthened tool ordering with a held first tool; cancellation after observed partial output; exact malformed-base64 null; explicit browser error variant; valid undeclared asset fixture; exact checkout refusal statuses; malformed/old blob addresses; surviving SQL row after rejected DELETE; exact stale SyncToken Http409; exact per-exchange OAuth hit delta; real-browser media progress deadline; no-rows-after-cancel; inert declarations reject/drop an implementation option. Removed unused fake Web Locks and recorder recovery/cancel failure fields.

Capture Result-helper changes were reverted because the package has no wellcrafted dependency; its existing result checks remain. Native Transcribed is an uncorrelated response object, so its error:null assertion remains valid and is excluded from Result helper conversions. Conversation and other ordinary response error fields were preserved.

Documentation: corrected 16 leading JSDoc blocks and transferred sync-subprotocol placement; corrected claims about compiled Mail, streamed sidecar turn, read-only reconciliation, and browser blob lifecycle. Expanded missing label-direction descriptions, removed redundant request subset assertions and unrelated absent Skill row padding.

Final validation: Local Books 103/0, Local Mail 175/0, Agent 28/0, Blobs 92/0, Skills 3/0, Epicenter 200/0, Whispering 239/0, Self-host 27/0, Capture 77/0. Explicit transferred app files: 116/0. Package tests included Epicenter scripts/build-applications.test.ts and scripts/build-sidecar.test.ts, and Whispering native/{audio,close,failure-injection,host}.test.ts; these are actual configured runtime suites, not skipped header checks. Whispering native TypeScript fixtures exercise its JavaScript host with test-owned audio/recorder stand-ins and do not establish live Rust hardware recording behavior. Focused package typechecks are clean; parent also confirmed full workspace typecheck exit 0 after corrections. Changed owned paths: /tmp/epicenter-testing-grill/changed-3.txt (43 files). Agent abort gate always releases and disposes in finally, including assertion failures. No production files changed.
