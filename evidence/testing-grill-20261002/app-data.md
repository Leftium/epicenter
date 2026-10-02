Testing deletion grill partition 1

Baseline: bun test --isolate on all 121 assigned paths: 1256 pass, 3 fail, 1 error; see baseline-1.log. Root owns package-configured baseline.

## apps/api/dev-auth.test.ts

Retain all five: real Hono middleware drives localhost rejection, missing/non-dev/empty bearers, and synthetic principal resolution. Removing resolver tests would lose distinct trust-boundary inputs.

## apps/api/runtime-profile.test.ts

Delete fixture-only rationale assertion: filtering PROFILE for its own why field cannot detect a production regression. Retain all routing and outage probes: real Worker/Bun entries, signed bearer database outage, absent methods, and anonymous blob bypass detect omitted mounts and eager database access.

## apps/api/scripts/dev.test.ts

Retain both: command literals pin deployed developer entry contracts and source ordering checks fence launcher side effects. Runtime replacement would execute Infisical and remove secrets; no safe production extraction authorized.

## apps/api/ui/src/lib/auth/session-request.test.ts

Retain both table-driven groups: exact browser/native binding, reauthentication, credential-bearing/relative/duplicate callbacks and malformed state exercise real parser rejection.

## apps/api/ui/src/lib/dashboard/navigation.test.ts

Retain all four: expected identity, unaffiliated visit, ambiguous identities, and normalized return-path confinement exercise navigation decisions. Add contract JSDoc.

## apps/api/ui/src/lib/dashboard/runtime.test.ts

Retain every case: deferred fetches genuinely finish after same/different-principal disposal, cache/mutation isolation and captured Account headers exercise real asynchronous decisions. Management SDK error fields are plain Better Auth responses, not Wellcrafted Results.

## apps/api/worker/account/routes.test.ts

Retain all six: throwing database/binding proxies make partial deletion reachable and visible; fresh/retried/stale/missing/mismatched/session-outage requests pin refusal envelopes.

## apps/api/worker/billing/autumn-products.test.ts

Retain both: actual provider product declarations pin free, usage-based, and prepaid billing wire shape. Add truthful JSDoc.

## apps/api/worker/billing/autumn.test.ts

Retain all seven: real Autumn and ConnectionError classes expose both discriminator families, opaque mapping, programming-bug rethrow. Replace Result destructuring with expectErr.

## apps/api/worker/billing/policies.test.ts

Retain all billing cases: real service and policies plus restored SDK prototype spies expose confirm/release, top-up quantity, plan choice, STT rounding, outages, and async 202 bodies. Await unknown-plan rejection; use expectOk/expectErr for metering Results.

## apps/api/worker/session-callbacks.test.ts

Retain every explicit and generated origin case: independent callback literals catch trust expansion and exact desktop-port validation. Correct header from three to four production app callbacks.

## apps/api/worker/storage/service.test.ts

Retain all six: ordered dependency events and upserts detect wrong accounting, exact-limit acceptance, duplicate registration, and hosted Bun policy outages.

## apps/api/worker/trusted-origins.test.ts

Retain all six: wildcard ban differs from extension ban; deployment origins and frozen arrays pin real auth/isolate contracts. Add JSDoc.

## apps/matter/src/lib/components/board.test.ts

Retain all seven: reverse within-bucket stem order, five-field fallback fixture, missing buckets and invalid/no-op drops reach separate renderer decisions. No collapse loses useful coverage.

## apps/matter/src/lib/editor/markdown-live-preview.test.ts

Retain all sixteen syntax cases: real CodeMirror parser and selection ranges expose marker offsets, nested links, title punctuation, unsupported syntax, and multi-line selection. Add missing JSDoc.

## apps/matter/src/lib/editor/markdown-shortcuts.test.ts

Retain seven: real EditorState transactions distinguish included/outer markers, exact-marker nesting and independent selections; document plus cursor assertions detect different regressions.

## apps/matter/src/lib/routes.test.ts

Retain ten: panel/view namespace collision, untyped tables, absent/unknown params and generated URL literals protect actual route grammar.

## apps/matter/src/lib/view/projector-roundtrip.test.ts

Retain the integration: actual parse/classify/project/query pipeline with real SQLite catches SQL projection regression that helpers alone cannot. Use expectOk for parse and using for SQLite lifetime.

## apps/sync-lab/worker/hibernation.test.ts

Retain five real Cloudflare eviction/control scenarios: incarnation controls expose failed eviction, ack/inFlight catches dropped pushes, re-delivery observations prove wake behavior, large snapshot fixture reaches snapshot-only wake. Bun import failure is wrong runner; configured Vitest owns validation.

## apps/todos/server/git-server.test.ts

Retain complete real Git HTTP/native CLI/browser roundtrip: independently checks bare history, file bytes, completion, browser fast-forward and log ordering. Replace raw Result checks with expectOk.

## apps/todos/src/lib/editor.test.ts

Retain every explicit and five generated unreadable-conflict case: deferred save and move replies reach typing races, differing sha256 reaches conflict, throwing successful-read fake excludes unwanted readback. Raw/todo cases use different application adapters. No test deletion justified.

## apps/todos/src/lib/files.test.ts

Retain both grouped behaviors: real tree ordering/exclusion plus BOM/NUL/invalid UTF8/over-limit branches expose byte corruption risk. Replace Result data peeks and empty-string hedge with expectOk and explicit text narrowing.

## apps/todos/src/lib/platform-selection.test.ts

Retain both actual bundle graph probes: platform condition/alias fallback can pass typecheck, so forbidden host/browser module reachability is a concrete runtime boundary contract.

## apps/todos/src/lib/status.test.ts

Retain four: status snapshot divergence outranks dangerous transport guidance, error-name mapping, current header priority, and absolute observation dates exercise display decisions.

## apps/todos/src/lib/todos.test.ts

Retain all cases, including generated literal bad/empty stems: real browser folder and controlled post-write gates expose stale reads, rename ownership, typing preservation, conflict review, explicit discard, sibling-file survival, hints and reentrant close. Challenges to duplicate raw/todo scenarios rejected: adapters and failure windows differ. Full file reviewed in segments; real Git transport only retained in dedicated integration.

## apps/vocab/src/lib/boot-node.test.ts

Retain four boundary probes: callback existence makes negative source loop non-vacuous, working page and shell have independently enforced acquisition contracts. Correct stale AppBoot header/name to actual resource opening.

## apps/vocab/src/lib/chat/dictation.test.ts

Retain all five: actual OpenAI SDK plus deferred client/startup/transcription and real stop speech callback expose microphone release and late-result cancellation. Fakes genuinely reach pending work rather than parking before it.

## apps/vocab/src/lib/chat/messages.test.ts

Retain all six: real reopened stores test account/conversation isolation, deduplication, earliest-question selection and one-to-three focus bound. Rename focused-chat case to actual stored-expression assertion; no deletion occurs in fixture. Add JSDoc.

## apps/vocab/src/lib/chat/opening.test.ts

Retain both: real conversation persistence and held generator expose remount idempotence and stop/retry from empty history. Add JSDoc.

## apps/vocab/src/lib/data.test.ts

Retain declaration assertion: table names/domain identifiers address durable data and are outside compiler protection. Add JSDoc.

## apps/vocab/src/lib/import.test.ts

Retain one compound example: exact expression punctuation plus repeated/saved categories detect trimming and dedup decision regressions. Add JSDoc.

## packages/app/evidence/data/current-generation/authority.test.ts

Retain every activation, rollback, receipt, stale-handle and input-alias case: real SQLite triggers reach transactional rollback and reopened authorities expose durable receipts. Capture beyond one batch and stale byte/position mutation are independent loss mechanisms.

## packages/app/evidence/data/current-generation/hub.test.ts

Retain every generated and explicit hub lifecycle case: decoded wire frames and synchronous callback reentrancy genuinely activate during delivery/ack/refusal/admission, partial submissions reach retirement, and SQL triggers exercise rollback. Old/new-owner relay identity is exercised by cross-peer delivery rather than identity alone.

## packages/app/evidence/data/deletion-model.test.ts

Delete two generated convergence-only repetitions: exact same setup already retained in model-specific concurrent delete cases asserting both readers undefined. Retain model difference, sequential delete, resurrection, hidden peer fields, dead-key listing and body-edit scenarios. Correct misleading ordering name to actual causally later deletion.

## packages/app/evidence/data/delta-names-the-row.test.ts

Retain all seven: real installed Yjs events expose created/edited/deleted/remote ids, transaction grouping, origin, observeDeep limitation and ordering ahead of followers. Negative second-table controls prevent listener contamination.

## packages/app/evidence/data/detached-type.test.ts

Retain eight installed-Yjs premises: detached bulk/text/attribute writes, reversed appends, unreadable prelim state, integration exceptions and peer conversion catch codec hazards. Fresh detached doc ownership is a library contract; paired attached controls establish reachability.

## packages/app/evidence/data/independent-document-roots.test.ts

Retain both text/map scenarios in one case: concurrent independent named-root creation through actual Yjs updates preserves distinct edits. Add contract JSDoc.

## packages/app/evidence/data/invariants.test.ts

Retain every Yjs/data premise: persistent root grammar, independent root versus nested identity, deletion-invisible vectors, buffered causal gaps, replay order/idempotence, reclamation and name semantics. Overlapping dependency tests cover map versus text chains and explicit controls; cannot replace with simpler single-path fixture.

## packages/app/evidence/data/retention.test.ts

Retain three authority/storage-wire cases: canary scan independently detects deleted content until client snapshot, snapshot replay correctness and empty caught-up tail. Not an erasure/product claim.

## packages/app/evidence/data/rewriting-a-body.test.ts

Retain four explicit low-level experiments: root identity, concurrent complete rewrites, inside-deleted-block loss and independent-new-block survival are distinct Yjs merge limits.

## packages/app/evidence/data/row-snapshots.test.ts

Retain four: value snapshots, faithful stored view, live body access, storedRow identity. Strengthen body case by holding the actual node before edit and comparing same object afterward; dispose both memory stores after every test.

## packages/app/evidence/data/validation.test.ts

Retain seven candidate-validation controls and mutation sweeps: real full/incremental updates plus seeded receiver expose corruption accepted by documentless filters and conservative refusal direction. These pin installed library design evidence rather than authority production validation.

## packages/app/evidence/data/what-the-crdt-buys.test.ts

Replace forty random client-ID trials with two controlled opposite ID assignments. Higher client edits first, lower edits later, both replicas must retain higher-ID value. This directly detects tie-break regression and removes probabilistic sampling. Retain per-field/value/text merge contrast.

## packages/app/src/ai-connections.epicenter-host.test.ts

Retain five: actual desktop connection catalog plus deferred response/event stream exposes revision ordering, opening failure/closure, exact multipart bytes and stripped authorization/cookies. Stream fake actively delivers all lifecycle events.

## packages/app/src/ai-connections.test.ts

Retain seven: same-URL independent credentials/ids, failed atomic save, detached input/snapshot arrays, destination-only external events, malformed persistence and closure guards. Storage-map fake reaches refused writes and observer paths.

## packages/app/src/ai.test.ts

Retain all eleven: actual SDK streams and response cancellation expose retained clients, credential refresh/rotation, tool-argument retirement, late headers, nonabort cancellation failures and extracted closure methods. Pending cancellation deliberately ignores abort where required; fixture reaches drain race.

## packages/app/src/app.test.ts

Retain five personal lifecycle cases: actual open-store/account composition, hydrated reopen, retired framing and terminal invalidation debt, attach-time retirement, wrong-principal pending pushes. Delayed backing/socket controls expose readiness and owner-fencing paths.

## packages/app/src/blob-copy.test.ts

Retain one integration: independent definitions mint distinct byte identities, deleting source leaves target, forged source throws before fake get runs. Different assertions protect separate public ownership contracts.

## packages/app/src/clipboard.browser.test.ts

Retain two: late-installed navigator proves call-time lookup; missing API exposes browser leaf failure mapping. Convert Result checks to expectOk/expectErr.

## packages/app/src/clipboard.test.ts

Retain all normal/empty/null/undefined/failure read and write cases: source values drive normalization and original causes survive named failure mapping. Convert Result checks to expectOk/expectErr.

## packages/app/src/data/__benchmarks__/root-rotation.test.ts

Retain five behavioral assertions despite benchmark directory: real Yjs replacement, cold reopen, offline edit loss, concurrent subtree selection, writer metadata and root-scoped undo reach distinct replacement hazards. This is assertion-based experiment, not a timing report.

## packages/app/src/data/artifact/body-boundary.test.ts

Retain five: field names body/content/! coexist with child sequence, nonconformance cannot hide body, separate/mixed notification counts, persistence attributes and retained deleted-node reference protect real grammar boundaries.

## packages/app/src/data/artifact/field-changes.test.ts

Retain seven: actual Matter edit serialization, own prototype-like fields, semantic JSON equivalence, nullable deletion, permission checks and KV null-vs-delete exercise independent preflight decisions.

## packages/app/src/data/artifact/frontmatter.test.ts

Retain nine: independent expected YAML text detects string reinterpretation, keys/JSON values/frame endings, actual Matter edit fidelity and malformed/Unicode boundary inputs. Add JSDoc.

## packages/app/src/data/artifact/optional-body.test.ts

Retain three: real artifact render/import rejects populated uncoded sequence/attributes and nonempty incoming bodies while fields-only empty nodes roundtrip.

## packages/app/src/data/definition/compile.test.ts

Retain nine; repair baseline malformed-codec scenario to call actual compileData Result boundary rather than identity-only defineStore. Remove codec-shaped object with valid function members from invalid input set; include absent/nonfunction decode/encode instead. Malformed name/message asserted, runtime validation preserved. Focused nine pass.

## packages/app/src/product-startup.test.ts

Retain both product startup cases and all interruption/optional-acquisition branches. Repair stale bundle fixture missing chatHistoryDefinition; Vocab has two optional acquisitions, Mail three, so parameterize expected failure count per product. Package-cwd tests both pass (startup-package-1.log). Root-cwd build cannot resolve app-local wellcrafted/error, confirming package runner matters.

## packages/app/src/data/artifact/import.test.ts

Retain all schema, body decoding, malicious codec, KV, prefix and identity import cases. Remove duplicate throwing-codec case: retained refusal case has identical path plus message assertion. Use expectOk for rendered streams and remote apply; await disposal. Existing row/body assertions reach current public artifact contracts.

## packages/app/src/data/artifact/render.test.ts

Retain all rendered body, unwritable row, settings, undefined/null, and partial-stream failure cases. Each checks external bytes or failure position against independent expectations. Add file JSDoc and expectOk stream narrowing.

## packages/app/src/data/open.test.ts

Retain opener profile, identity/addressing, generation observation and disposal cases. Fakes model real authority replies and persistence resources; assertions cover invalid address refusal before acquisition and generation transitions.

## packages/app/src/data/store/browser.test.ts

Retain complete browser persistence acquisition, blocked/versionchange, cross-context generation change, release, and failed acquisition cases. Fake IndexedDB tests reach production browser opener; error and resource assertions distinguish refusal paths.

## packages/app/src/data/artifact/checkout.test.ts

Read all 2,046 lines and every case. Retain manifest addressing/ownership, nullable field three-way decisions, body identity, codec refusal, KV, admission/deletion, retained files, approval races, missing ETags, conditional writes, stale retries and decline/no-effect contracts. Remove three strict subsets: empty-folder manifest-only check already covered by complete first pull, duplicate changed-title preview, duplicate decoder throw preview. Fix misleading codec preview name and stale planPush/filesystem header. Real host race fake compares If-Match after simulated writes; no production changes.
## packages/app/src/data/store/current-open.test.ts

Retain canonical install/offline cache, account outbox isolation, retirement/replacement, malformed/truncated downloads, complete 130-update captured tail, and unresolved struct/delete refusals. Each rejection retries a valid download to detect partially published cache. Move header before imports.

## packages/app/src/data/store/document.test.ts

Retain all row mint/update/delete, reserved field, preflight atomicity, body child grammar and chosen-ID versus minted-ID convergence cases. Tests use actual live Yjs nodes; existing collision assertion accepts either deterministic CRDT winner, so random client IDs cannot make it flaky.

## packages/app/src/data/store/flush-on-hide.test.ts

Retain six no-page, visibility guard, pagehide, combined events and listener-disposal cases. Remove rejected-promise case falsely claiming a throwing callback was caught: only asserted synchronous hide did not throw, duplicated invocation, and left a rejection unhandled. Production hook deliberately drops callback return.

## packages/app/src/data/store/idb-runtime.test.ts

Retain local/personal factory-isolation cases: writes land in only first realm, offline reopen holds distinct lastId/outbox, ambient factory identity unchanged. Uses actual fake-indexeddb instances and production acquisition.

## packages/app/src/data/store/idb-transactions.test.ts

Retain request-error settlement after rollback, failed fold/install/retirement and same-backing retries. Prototype faults occur after partial writes and durable reopen checks catch publication regressions; prototypes restored in finally.

## packages/app/src/data/store/persist.test.ts

Retain unavailable/already-granted/refused/policy-rejected browser outcomes; already-granted pins no prompt. Manager captured before await by production so fixture restoration timing doesn't bypass later persist call.

## packages/app/src/data/store/persistence.test.ts

Retain all live acceptance/durable debt, ordered retry/coalescing, blocked close/restart, status transitions, queued send/remote cursor/ack ordering, discarded queued/inflight work cases. Remove permissive local expectOk shim accepting plain values; import real Result assertion and call infallible mutators directly. Real SQLite replay and gated atomic ports detect loss/duplication rather than mirror controller implementation.
## packages/app/src/data/store/port-conformance.test.ts

Retain both engine runs of all append/reopen, owed positions, ack retirement/reack, folding, merge races, controller mirror, mostly owed thresholds and successful/failed atomic batches. Same causal update chain and independently replayed final values expose real SQLite/IDB divergence.

## packages/app/src/data/store/store-opening.test.ts

Retain every retained-capability fence, subscription teardown, shared close completion, deferred hydration, failed/corrupt acquisition, cleanup exception, reentrant transaction/subscriber close and late real socket case. Manually held promises prove resource completion and prevent accidental hydration/commits after close.

## packages/app/src/data/store/store-retirement.test.ts

Retain five write fences, failed invalidation/retry, retirement during attachment, abort-triggered close race and missing invalidation support. Assertions distinguish unusable capability from durable resource ownership; actual sync adapter drives retirement frames.

## packages/app/src/data/store/store.test.ts

Read all 1,231 lines and all cases. Retain row mint/refusal/nonconformance, delete/churn, replica exchange, KV, dependency replay, pressure, notification depth/id/phase, declaration reopen and ownership contracts. Strengthen misleading absent-body/deleted-body scenarios to assert body() rather than only get(). Add truthful file JSDoc, dispose per-test base store, use Result helpers for actual Result boundaries. Broad cases test different observable public contracts even when setup repeats.

## packages/app/src/data/store/sync.test.ts

Retain every durable remote-byte count/outbox, local body obligation, merge completeness, cache coalescing, in-flight acknowledgement, cursor reopen and concurrent body edit case. Replace permissive Result-or-value shim with expectOk and direct infallible create. Rename last-only control: it proves an incomplete note set, not unresolved Yjs dependencies (assertion already says false).

## packages/app/src/data/sync/attach.test.ts

Retain exact URL/subprotocol/cursor, status attachment teardown, permanent denial versus network failure, late socket release, connecting/already-open admission and repeated retirement cases. Fake events enter real socket adapter and discriminate connection states.

## packages/app/src/data/sync/authority.test.ts

Retain seven opaque byte sequencing/snapshot/seed constraints and partial seed rollback/retry. Unreadable payloads pin authority byte ownership; chunk fault occurs after partial inserts, head/snapshot/tail assertions detect partial publication.

## packages/app/src/data/sync/frames.test.ts

Retain three controls: roundtrip plus one-byte encoding, extra payload refusal and historical opcode refusal. Acceptable roundtrip is paired with independent wire size/invalid byte expectations.

## packages/app/src/data/sync/hub.test.ts

Retain both admission read failures, pre-ack catchup refusal/retry, snapshot/push correlation, synchronous reentrant chunk delivery, failed admission, retirement, and storage failure before/during partial assembly. Opaque independent bytes and exact outgoing frame ordering catch skipped durable positions.

## packages/app/src/data/sync/persistence-scheduling.test.ts

Retain four held-commit interleavings: late durable wakeup, live suppressed ack/durable recovery, burst during owed fold, completion-microtask next drain. Real SQLite reopen and observable push frames catch scheduling races hidden by synchronous ports.
## packages/app/src/data/sync/connection.test.ts

Read all 987 lines and all driver/clock/wire/admission cases. Retain automatic row/body send, lost-entry resync, offline/reconnect cursor, backoff reset, stalled submission watchdog, credential refusal, disposal, admission timeout, retirement and teardown races. Strengthen stale socket close: old test captured dynamic current wrapper and never closed the original, so only tested ordinary reconnect. Capture the real old attempt.closed, disconnect/redial first, and assert stale callback neither redials nor prevents delivery. Replace permissive Result/value shim and await disposal.

## packages/app/src/data/sync/transport.test.ts

Read all 2,315 lines and every deterministic/seeded case. Retain receiving-replica state, durable cursor ordering, fragmented entry/snapshot transfers, partial lifetime, malformed bytes/gaps, snapshot policy/authorization, upgrade preservation and seeded external-row-model convergence. Fix stale-partial scenario: old step consumed admission plus snapshot only, identical to control; take one more frame to leave actual entry fragment before reconnect. Snapshot acceptance control now reaches hub.receive instead of directly bypassing hub authorization. Add independent per-row body-length oracle to seeded fuzz so lost node edits fail (previously only counted attempted edits). Remove comparator smoke case that deliberately edited expected map after a costly fuzz and proved Array comparison only. Correct neutralization name and stale collector doc; Result helper failures.
## Validation and review completion

81 distinct assigned files fully read; all test cases evaluated. Root owns original tail25 and grill_three owns transferred app15. Test-only changed paths are visible in git diff; no production edits or branch/commit operations by this worker.

Configured affected-package runs: app334, API46, API UI4, Matter17, Todos3, Vocab14 tests passed (418 total, zero failures), logs final-{app,api,api-ui,matter,todos,vocab}-1.log. Full packages/app typecheck script passed across its seven TypeScript programs (typecheck-app-1.log). Earlier focused199 included store and checkout cases; final run supersedes it. Root owns full repository validation and worker-specific sync-lab execution.

Scratch mutation probes used rewritten imports under /tmp only. Removing the attempt.closed live guard: baseline old stale-close test passes, strengthened test fails. Removing client collector reset on attach/detach: baseline old stale-partial test passes, strengthened test fails. Logs probe-connection-{before,after}.log and probe-transport-{before,after}.log. These are missed-regression evidence, not production changes.

Final static check: every reviewed file starts with truthful JSDoc, no inserted import inside leading JSDoc; git diff --check clean. Clipboard helper import was initially accidentally placed in a comment; fixed, both browser clipboard cases pass and full app typecheck passes.
