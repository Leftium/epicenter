# Partition 2 testing grill

Status: all 121 assigned files reviewed; 32 test files changed. Final verification completed; checkout edits frozen. Read-only complete-file specialist reviews run against a frozen source snapshot; Codex adjudicates and integrates findings. Entries below have received direct source/fixture review.

## .agents/skills/agent-instructions/scripts/audit-routing-collisions.test.ts

Retain CLI subprocess coverage: exit status, stdout ownership/disclaiming lines, stderr always-on claimants and invalid/help input cross a real process boundary; description wording alone cannot replace routing behavior.

## .agents/skills/agent-instructions/scripts/audit-skill-links.test.ts

Retain disposable skill-tree scan cases: relative cross-skill links, fences, placeholders, external targets, heading anchors, JSON findings and real-tree links exercise distinct scanner filters and diagnostic contracts.

## .agents/skills/agent-instructions/scripts/skill-catalog.test.ts

Retain frontmatter extraction and phrase classification: wrapped/quoted fields and metadata boundaries exercise independent parsing failures; claimed/disclaimed/absent and mixed sentences reach actual classifier branches.

## .agents/skills/consult-claude/scripts/consult-claude.test.ts

Retain recording CLI subprocess fixture and real disposable Git repos: argv/stdin boundaries, resume, exit propagation, delegation sandbox settings, and rejected shared/nested/live workspaces detect launcher decisions; fake CLI explicitly does not prove installed CLI security.

## packages/constants/src/ai-providers.test.ts

Retain known gemini vendor label and unknown/empty raw labels: mapping and persisted historical-ID fallback are runtime display contracts; exhaustive live-key existence is already compiler-owned and omitted.

## packages/constants/src/app-id.test.ts

Retain reverse-domain admissions, bare-label refusal, path escapes, label edges, lowercase and separators. The bare-label check exposes a loosened grammar despite all first-party IDs still passing; unsafe groups exercise separate rules.

## packages/definition/src/addresses.test.ts

Strengthen ceiling coverage for all three ASCII grammars and correct unsupported byte-vs-character claim: setup only supplies ASCII and cannot distinguish byte length from character count. Add table boundary admission and data ID boundary admission/refusal; retain reserved sibling/path grammar cases. Add truthful leading JSDoc.

## packages/definition/src/compile.test.ts

Retain body-conversion preservation, nullable field checks, identity memoization and malformed body/unknown options: production compiler parses unknown declarations and memoizes by source-object identity. Negative type annotations intentionally reach runtime checks.

## packages/device/src/index.test.ts

Retain scoped database/secret-name minting assertions: path traversal and uppercase refusal plus valid mint directly exercise capability boundary validation, despite source being small.

## packages/device/src/app-claim.test.ts

Retain duplicate/per-account admission and key bytes, refused-release behavior, and unsupported/rejected lock subprocess cases: installed test lock fixture exercises arbitration; child process makes absence and rejection reachable without mutating sibling globals.

## packages/device/src/browser-sqlite.worker.test.ts

Retain recording pool subprocess: distinct app/database files and exact database/journal paths pin storage addressing and cleanup routing. Real acquisition/close/delete request handler executes; OPFS durability explicitly remains outside this substitute.

## packages/device/src/memory.test.ts

Retain real WASM SQL connection integration: committed-data persistence, rollback/temp-table loss, duplicate acquisition/disposal, independent runtimes and deleted-handle invalidation exercise real dependency boundaries rather than canned responses.

## packages/device/src/query.test.ts

Retain malformed reply tags/widths, row/column/serialized bounds, duplicate headers and exact-overhead boundary. Independent literal encodings and one-byte-over maximum expose unsafe external transport acceptance; empty rows still carry schema.

## packages/device/src/secrets.test.ts

Retain browser persistence/isolation and desktop wire payloads, per-platform readiness and retained closed methods, plus reentrant close/drain deferred response. Deferred promise makes pending write/close race reachable; simplistic immediate response cannot replace it.

## packages/auth/src/account-management.test.ts

Retain literal management URL and delimiter-containing principal cases: origin/path/query construction prevents identity injection and pins navigation contract; simple mapping has external consumer significance.

## packages/auth/src/instance-server.test.ts

Retain normalization and invalid-origin refusals plus exact origin-derived authority bytes: canonical equivalent origins, separate servers and persisted data address invariants are distinct; identity comparison cannot replace byte literal.

## packages/auth/src/instance-token.test.ts

Retain missing/short/passphrase rejection and generated token format/freshness/gate agreement. Random output is genuine generator input and hand-supplied weak values reach independent entropy/URL-safety checks.

## packages/auth/src/persisted-auth-format.test.ts

Retain runtime stored-session schema roundtrip and missing/empty/obsolete/extra fields: persisted JSON is untyped and must reject grant cells despite TS declarations; schema assertion participates in roundtrip so not a test-only tautology.

## packages/auth/src/refusal-is-not-an-identity-change.test.ts

Retain 401 refusal with captured Account identity: real session owner verifies cached identity through fetched refusal and publishes reauth-required preserving same object. This protects local-store lifetime not just a property assignment.

## packages/folder/evidence/closure/closure.test.ts

Retain compiler-program closure subprocess for folder and definition: exact allowed workspace ownership and forbidden Yjs/auth dependencies pin architecture beyond ordinary TS compilation, and source-presence assertion prevents empty program false passes.

## packages/server/evidence/enrollment/passkey-hooks.test.ts

Retain installed Better Auth plugin and real virtual WebAuthn verification with memory storage: successful resolved-user credential, consumed-hook insertion failure and competing ceremonies expose real third-party ordering; documentation correctly limits this to plugin ordering.

## packages/server/evidence/scope-ownership/foundation.test.ts

Retain subprocess browser startup through live Hono mount/SQLite authority, socket scope routing, restart phases and concurrent initializer prototype evidence. Separate real production behavior from explicit durable initialization prototype; no prototype claim of deployed persistence guarantees.

## scripts/check-api-paths.test.ts

Rewrite obsolete OAuth-grant inclusion expectation as exclusion after verifying 23bade0df4 deliberately removed regex and constants ownership. Current hardcoded API positive case remains, so scanner-noop regression still fails; fixture Git repos required because script root is git-derived. Baseline failed old OAuth case; final focused suite passes.

## scripts/check-vocabulary.test.ts

Retain tracked-files Git fixture: language scope, exceptions/ignore directives, line-level diagnostics, generated files and product-name false positives are actual scanner boundaries; untracked fixture is intentionally excluded and cannot be replaced by direct regex checks.

## packages/auth/src/persisted-auth-storage.test.ts

Retain corrupt/missing WebStorage reads, removal, and serialized preload/write cases: actual storage adapters read/write independently; MemoryStorage implements required Storage shape and does not exclude parser failures.

## packages/auth/src/read-api-session.test.ts

Replace hand-unwrapped Results with expectOk/expectErr and add truthful JSDoc. Expand named 401/403 refusal to parameterized actual statuses; retained successful literal route/bearer/cookie checks and thrown/unexpected/malformed cases reach distinct production branches.

## packages/auth/src/session-authority.test.ts

Retain restored cached identity without network, selected issuer separation, same-person repair and non-Cloud callbacks, and hosted historical authority/management URL. Fake fetch records origins and rejects foreign-origin attempt; window descriptor restoration prevents cross-suite leakage.

## packages/client/src/hosted-blobs.test.ts

Replace Result success/error property checks with expectOk/expectErr and add truthful JSDoc. Retain captured owner/visibility wire request, returned foreign-owner refusal, download/delete methods and foreign-owner deletion before transport; fake Account members satisfy real interface.

## packages/server/src/auth/parse-bearer.test.ts

Retain independent literal header extraction, case/space variants and missing/wrong schemes: a small parser governs HTTP credentials and malformed input must not be admitted.

## packages/server/src/auth/base-config.test.ts

Retain actual production auth configuration and real installed Better Auth handler refusals. The rest of auth tests enable password to create fixtures, so cannot replace password-disabled production check; cookie absence and status protect session creation boundary.

## packages/server/src/auth/cookie-config.test.ts

Retain real Better Auth getCookies on HTTP localhost, IPv4/IPv6 loopback and deployed HTTPS: scheme/name/secure/Lax/domain are browser wire contracts, distinct hostname recognition rules justify overlap.

## packages/server/src/auth/create-auth.test.ts

Retain complete and incomplete provider credential sets: different provider requirements, including four Apple fields, flow through actual registry. Exact object equality catches malformed registration or accidental partially configured credentials.

## packages/server/src/auth/instance-token.test.ts

Replace Result hand-unwrapping with expectOk/expectErr. Retain exact instance identity with no fabricated email and wrong/prefix credential refusals; literal external error/principal contracts survive hash-based comparison implementation changes.

## packages/server/src/auth/oauth-resource.test.ts

Retain live Hono JSON error mapping: invalid-token 401 plus exact WWW-Authenticate and server-error 503 without challenge are wire contracts; plain JSON body assertions are not Result unwraps.

## packages/server/src/auth/plugins.test.ts

Retain installed Better Auth handler for sessionless authentication, session-required registration and valid fresh expected-principal ceremony. Real generated challenge/RP/user and production session ages/password setting protect browser protocol and security composition.

## packages/server/src/principal.test.ts

Retain independently specified durable authority names for user/instance and generation separation. Even though construction is small, changing persisted namespace bytes is a real external contract regression not compiler-owned.

## packages/server/src/routes/auth.test.ts

Retain live Hono routing with real query encodings and recording provider handler: sign-in stays a private shell, arbitrary callbacks never redirect, removed consent/discovery remain absent, and dashboard callback avoids catch-all. Stub handler status proves routing decision.

## packages/server/src/routes/personal-blob-url.test.ts

Add truthful leading JSDoc. Retain mint/parse storage addressing, independent key grammar/freshness and every noncanonical case: origin/protocol/credentials/query/hash/encoding/traversal each exercise actual unknown URL boundary; generated valid URL supplies a real parser input.

## packages/server/src/routes/session.test.ts

Add truthful leading JSDoc. Retain live Hono response with and without email: external response literal catches mistaken internal id vs principalId projection; cookie/auth extraction belongs to middleware coverage.

## packages/ui/src/natural-language-date-input/parse.test.ts

Retain explicit reference-time timezone fixtures: Los Angeles/New York offsets, Tokyo date rollover and elapsed-hours independence expose distinct calendrical failures; fixed times avoid machine-clock flakiness.

## packages/folder/src/git/commit-subjects.test.ts

Retain committed cross-language golden fixture comparison and boundary-distribution assertions: fixture equality catches TS/Rust drift, while exact72/fallback populations protect the fixture from losing boundary inputs even if regenerated.

## packages/folder/src/native-best-effort.test.ts

Retain actual disk exclusive-create race with delayed preflight barrier: both creators see vacancy, exactly one lands and sibling audio remains unchanged. Instant setup would hide the race; file bytes and returned capture detect ownership and winner consistency.

## packages/server/src/local-blob-store.test.ts

Retain real SQLite publication plus mounted HTTP lifecycle: create-only conflict, reopened exact media/range bytes, conditional headers and private/public/delete access exercise durable dependency and route interplay. Deletion accepted after reading production put: the interrupted case directly rolls back its own INSERT and cannot expose a change in put (which uses one INSERT without that transaction). Retained “local publication, media reads, access, ranges, deletion, and reopening” reaches production put, asserts occupied-key conflict, exact bytes after reopening, and absence after deletion. Remove raw SQL column-name fixture and Database import.

## packages/server/src/s3-blob-store.test.ts

Retain local HTTP endpoint receiving genuine AWS4-signed production adapter requests: create-only If-None-Match, 412 conflict, HEAD metadata, range and If-Match, absent/idempotent deletion all cross real fetch boundary. Fixture responds to requests rather than echoing preconfigured values.

## packages/sqlite/src/adapters.test.ts

Retain runtime-adapter conformance with real Bun and OO1 WASM connections; DO shape delegates to real SQLite transaction. Committed writes/rollback, OO1 nested refusal and bound typed values expose different adapter mistakes. DO runtime semantics additionally live in workerd tests.

## packages/server/src/middleware/cors.test.ts

Retain mounted origin allow-list, absent origin and rejection; deliberate stand-in route isolates deployment-supplied trust policy. Prior unrelated transport header coverage is already removed, and doc explains limited scope honestly.

## packages/server/src/middleware/rate-limit.test.ts

Retain deterministic long-window quota boundary and independent-principal buckets on one limiter. Same limiter instance and switched principal makes global-counter regression reachable, while literal429/envelope pins inference client contract.

## packages/server/src/middleware/require-auth.test.ts

Retain real Better Auth session/cookie and Hono route validation: signed bearer overrides foreign cookies, malformed/unsigned rejected, renewal preserves age/token, revocation isolates clients and infrastructure/renewal races map401 vs503. Actual adapter overrides make failures reachable.

## packages/server/src/middleware/require-origin-for-cookie-mutations.test.ts

Retain actual mounted origin middleware: foreign/missing cookie origin refusal, trusted-cookie pass, bearer/no-origin pass and GET bypass exercise distinct security decisions. Fake billing route is intentional middleware sink, not production billing extraction.

## packages/server/src/auth/account-linking.test.ts

36 cases reviewed in full by read-only specialist; source findings: - **Keep.** A real Better Auth handler runs with the production `BASE_AUTH_CONFIG`, `authPlugins` and `requireAccountSession`; only the provider token and user-info calls are stubbed, as the JSDoc says.
- Regressions it reaches:
  - bearer-over-cookie selection (215-253, with per-route side-effect checks);
  - the 600 s freshness boundary (166-195);
  - 503 versus 401 on outage (254-272);
  - link target surviving sign-out or replacement (276-311);
  - unverified GitHub refused (350-382).
- **Delete the `600_001` age** at line 166 (4 cases). Retained: "`${path} refuses a session aged 600000ms`" covers the `>=` boundary.
- **Add the two missing management paths** to the gate loop (401 / `PRINCIPAL_MISMATCH` only).
- A wider collapse of the 4-route matrix is possible but not recommended. The per-route accept side proves each endpoint consumes the hook-injected session.

## packages/server/src/auth/session-handoff.postgres.test.ts

8 cases reviewed in full by read-only specialist; source findings: - **Keep.** A real Postgres cluster, the real `createAuth` and Drizzle migrations reach the `DELETE … RETURNING` single-use contract that the memory adapter cannot.
- **Delete line 52:** a config echo inside `setup`, run 8 times. Retained: `base-config.test.ts:41`.
- **Delete line 131:** subsumed by the exact table list at 132-139.
- **Candidate:** fold `resolved.session.id !== source.id` (266) into the subprocess race, then delete 240-274. The JSDoc itself says only the subprocess test escapes in-process locks. Retained: "separate Bun processes race one code into exactly one Postgres session". This is a moderate call; the in-process test diagnoses faster.
- There is no skip guard when `initdb` is absent. That fails loudly by design; confirm it is intended for `bun test src`.

## packages/server/src/auth/session-handoff.test.ts

12 cases reviewed in full by read-only specialist; source findings: - **Keep** the plugin-logic cases: binding mismatches (146-158), callback and origin refusals (160-196, 252-282), expiry and revocation (198-210), age preservation (212-233).
- **Delete 235-250:** it tests Better Auth renewal under test-built config. Retained: `require-auth.test.ts:104` "ordinary resource traffic extends expiry without changing session age or token".
- **Delete 284-301:** it builds its own `bearer({ requireSignature: true })` and never touches `authPlugins`. Retained: `require-auth.test.ts:87` "cookies cannot rescue missing malformed unsigned or invalid bearers" (unsigned and tampered tokens through production plugins).
- **Line 135-144:** the memory adapter cannot expose a non-atomic consume, so this proves replay, not concurrency. Rename it to say so; the Postgres file owns the race.

## packages/server/src/auth/signed-session-socket.test.ts

2 cases reviewed in full by read-only specialist; source findings: - **Keep.** It uses a real `Bun.serve` and a real `WebSocket`; lines 92-99 prove the raw token is rejected by the constructor, so the encoding claim is reachable.
- **Strengthen:** the `expect`s at 113-117 run inside the authority handler, so a failure surfaces as "socket refused". Capture the values and assert after open.
- Lines 171-183 are the only direct `extractUpgradeBearer` negatives; keep.

## packages/server/src/create-cloud-context-middleware.test.ts

7 cases reviewed in full by read-only specialist; source findings: - **Keep.** The 2×2 matrix with deferred promises genuinely orders close after the slow settle; the rethrow and auth-construction paths are distinct `finally` routes.
- **Dead fake:** the `resolveAuthSecrets` throw at 43-46 is unreachable, because `connect` throws first and shells never install the middleware. Remove it.
- Lines 27-30 re-inline `identity`; reuse it.
- The first test's name undersells it: it also asserts CSRF 403s and the preflight. Rename or split.

## packages/server/src/routes/authority-blobs.test.ts

9 cases reviewed in full by read-only specialist; source findings: - **Keep.** The real `resolveDeploymentBlobStore` behind a stubbed `fetch` covers create-only writes, the size caps, owner and visibility gates, If-Range fallback and 416.
- **Leading JSDoc is missing.**
- Several names are lists (77, 143, 289).

## packages/server/src/routes/inference.test.ts

6 cases reviewed in full by read-only specialist; source findings: - **Keep five.**
- **Delete 167-203:** the gateway has no provider-specific stream code. Retained: the Gemini case's `toBe(upstream)` at 159. Also tighten line 111 from `toContain` to exact equality.
- Untested documented errors: 502 `upstream_unreachable`, non-JSON upstream wrap, empty `messages`.

## packages/server/src/routes/transcription.test.ts

5 cases reviewed in full by read-only specialist; source findings: - **Keep.**
- **Strengthen 120-124:** add `response_format: 'text'` to the client form so line 138 proves forcing rather than adding.

## packages/server/src/self-host-auth/bun.test.ts

1 case reviewed in full by read-only specialist; source findings: - **Keep.** Real file reopen.
- **Hedged:** bare `rejects.toThrow()` at 124-126; pin the message.

## packages/server/src/self-host-auth/index.test.ts

15 cases reviewed in full by read-only specialist; source findings: - **Keep.** Real ES256 WebAuthn over SQLite covers single-use, rollback, expiry and body caps.
- **Unused fixture:** `enroll` returns `grant`, `ceremony` and `response` (72-74) that nothing reads, and its `id` parameter is never passed.
- **Hedged:** bare `toThrow()` at 461 and 471.
- The begin-registration block is copied five times (99-109, 184-194, 371-379, 403-413, 433-443); extract one helper.

## packages/server/src/store-sync/browser-dial.test.ts

6 cases reviewed in full by read-only specialist; source findings: - **Keep.** The dial comes from the real client and goes through the real gate; the negative at 212-225 is honest.
- **JSDoc is not leading:** an import sits on line 1.
- **Dead fake surface at 129-132:** `initial`, `allocate`, `admit` and `holds` are not in `GenerationsLedgerStub`, and the socket path never calls the ledger. Reduce to `list`, or throw as `foundation.test.ts:111` does.

## packages/server/workers/account-deletion.test.ts

3 cases reviewed in full by read-only specialist; source findings: - **Keep.**
- **Strengthen:** assert `SESSION_NOT_FRESH` at line 120; status alone cannot distinguish it from `PRINCIPAL_MISMATCH`.

## packages/server/workers/authorization-deadline.test.ts

8 cases reviewed in full by read-only specialist; source findings: - **Keep all.** Real workerd hibernation, alarms and attachment reconstruction; uses `expectOk`. No changes.

## packages/server/workers/current-retirement.test.ts

3 cases reviewed in full by read-only specialist; source findings: - **Keep all.** No changes.

## packages/server/workers/e2e.test.ts

5 cases reviewed in full by read-only specialist; source findings: - **Keep.**
- Line 68 `.then((made) => made)` is a no-op.
- The `describe` title does not fit the two refusal cases.
- The 500 ms negative wait (141) is documented and acceptable.

## packages/server/workers/generations.test.ts

5 cases reviewed in full by read-only specialist; source findings: - **Keep.** Deployed-route isolation and refusals.

## packages/server/workers/initial-generation.test.ts

5 cases reviewed in full by read-only specialist; source findings: - **Keep.** This is the production owner of the behaviours that `foundation.test.ts` prototypes.

## packages/server/workers/large-snapshot.test.ts

2 cases reviewed in full by read-only specialist; source findings: - **Keep 64-90.**
- **Delete 92-100:** it tests SHA-256, not production. Retained: the length check at line 88 plus the digest at 89.
- **Delete line 67:** it asserts a constant the test itself built.
- The JSDoc's "import or on bootstrap" is stale wording.

## packages/server/workers/selfhost.test.ts

1 case reviewed in full by read-only specialist; source findings: - **Keep.** The name omits the Shared-scope refusal it also asserts.

## packages/ui/src/confirmation-dialog/confirmation-dialog.test.ts

13 cases reviewed in full by read-only specialist; source findings: - **Keep all.** The sync-throw and async-reject cases protect different `try` placements, and the stale and dismiss matrices reach the `options === current` guards.
- A shared singleton means state can leak if a test fails mid-way. The harness's regex rewrite is fragile but documented.

## Adjudication of specialist proposals (third review)

- Base-config disabled-password sign-in previously also passed for an enabled provider with a nonexistent user. Pin status 400 and independently observed installed-library disabled-specific error codes for both sign-up/sign-in, retaining cookie absence.
- Transcription now sends conflicting response_format=text before asserting forwarded verbose_json, making override failure reachable.
- Vocabulary plural/capital test now requires diagnostics for both distinct files, preventing a single successful match from masking the other regression.
- Provider registry key-order assertion removed: no caller contract depends on insertion order; retained exact provider object equality detects missing/extra keys and credential wiring.
- Browser dial drops unused historical ledger methods and puts truthful JSDoc before imports; six actual client-to-server admission scenarios retained.
- Auth middleware takes the production session policy rather than re-declaring an incomplete copy; same expiry/age/error regressions remain covered.
- Historical principal helper tests retained; JSDoc now identifies historical rather than current storage names. Dead production export cleanup is outside this pass.
- Foundation prototype cases retained as explicitly exploratory evidence, rather than deleting an intentional model because current deployed policy differs.
- Large snapshot digest CONTROL retained: it also checks the locally implemented digest-to-string comparator is not constant, guarding false equivalence in the 8 MB transfer test. A direct crypto assertion alone would not earn this retention.
- Proposed handoff/session/plugin case deletions declined: issued-session age, deployment-secret verification, and cheap separately diagnosed REST projection retain distinct boundary input or diagnostic confidence.

## .agents/skills/agent-instructions/scripts/run-trigger-eval.test.ts

Full-file specialist review : 50 tests, retain core, fix five; all cases and fixture paths considered.

- **Retained regressions:** `runLexicalPass` near-miss silence (`:150-158`) and ambiguity (`:168-172`); `buildLiveArgs` never passing `--safe-mode` (`:193-207`); `parseLoadedSkills` dedupe and non-JSON tolerance; `judge` forbidden-beats-expected (`:278-286`); `summarize` flaky (`:320-329`); `fingerprintInstructions` and `compareStoredRun`; the corpus anti-rot checks (`:367-384`).
- **`:5` JSDoc:** cites an `enlist-claude` skill. No such directory exists under `.agents/skills`; the reference is stale.
- **`:423-429`:** see P0-3.
- **`:414-421`:** the comment "nothing may spawn the CLI" is not something the assertion can detect; it only checks stderr text. Soften the comment.
- **`:399-412` and `:528-539`:** these pin exact corpus content (exactly three `consult-claude` cases; clusters exactly `{review, claude-consultation}`). Adding a fourth case or a new cluster fails a test named "covers both". Use `every(...)` with a non-empty check, and a superset check.
- **Hedged `toContain` where the full list is deterministic:** `:144`, `:179`, `:188`. For example `:139-148` yields exactly `['UNOWNED_BY_EXPECTED','NO_OWNER']`.
- **`:316-318`:** named "fail at 0%" but never asserts `passRate`.
- **`:342`:** `expect(PROBE_ROUTER).toBe('claude')` restates an internal constant.
- **Missing:** the distractor validation that `EvalCase`'s own doc promises (`run-trigger-eval.ts:279-289`) has no test.
- **Tidy:** `:358-365` belongs inside `describe('validateCorpus')`. The corpus read is repeated five times.

## apps/honeycrisp/native-tests/close.test.ts

Full-file specialist review : 25 cases (21 blocks; `each` ×2 and ×4), retain all; all cases and fixture paths considered.

- **Reaches production:** real `openGuarded`/`registerPage`, real `createNotes`, and the real Rust gate replayed through `gate.ts`. This is a genuine wire and concurrency contract.
- **Fake surface:** every member of `folder()` is exercised (`holdWrites`, `loseReplies`, `holdReads`, `moves`, `paths`, `closed`).
- **Retained regressions:** fence before save (`:353-381`), no replay across reload (`:756-777`), approval failure modes (`:682-702`), rename never sent while closing (`:516-532`).
- **`:431`:** `toBeGreaterThanOrEqual(history)` cannot detect a history reset (a reset plus one edit also passes). `:429` already pins `toBe(history)`; delete `:431`.
- **`:419`:** `reviewed !== undefined && draft.takeTheirs(reviewed)` passes vacuously if `reviewed` is undefined. Throw on undefined first, as `file-session.test.ts:282` does.
- **`:523-524`:** one microtask tick is a weak negative. The later `moves === 0` at `:529` is the real check.

## apps/honeycrisp/src/lib/editor/markdown.fuzz.test.ts

Full-file specialist review : 4 tests, retain; all cases and fixture paths considered.

- **Reaches production:** `run()` re-parses `check.markdown` independently (`:257`), so the check is not taken on trust.
- **`:302`:** `toBeLessThan(2500)` is a loose bound. It is acceptable as a guard against refusing everything, and `:305-329` proves refusals exist.
- **`:253`:** builds a failure description for every refused document, but the adversarial test only uses `.length`. Make it lazy.
- **`:273`:** the `expect` after the throw guard can only run when it passes; harmless.
- **`:245`:** the doc says "the first few" but all are returned.

## apps/honeycrisp/src/lib/editor/markdown.test.ts

Full-file specialist review : 65 generated cases, retain, delete two; all cases and fixture paths considered.

- **Retained regressions:** whitespace entity pins (`:303-332`, the exact `&#32;` output), respelling (`:214-235`), refusals with reasons, task-marker escaping (`:361-372`).
- **Delete** `:258-261` and `:354-357` (P1-11, P1-12).
- **`:403`:** `schema.marks.underline` is redundant with the `Object.keys` equality at `:405`. The image-node check is not redundant.
- **`:290-300`:** a supported-input test sits inside the "is refused" describe.

## apps/honeycrisp/src/lib/editor/rich-session.test.ts

Full-file specialist review : 16 tests, retain all; all cases and fixture paths considered.

- **Fake surface:** all three members of `draftOf` (`input`, `refuse`, `admits`) are reached via `rich-session.ts:226,242`.
- **Retained regressions:** refusal before display (`:162-175`), fenced input not shown (`:177-193`), sync resets history without writing (`:236-256`), Enter does not bump `updatedAt` (`:110-123`).
- **`:190`:** the `>=` hedge is redundant with the undo-all check at `:191-192`; delete it.
- **`:267`:** `toBeLessThanOrEqual(2)` admits a wrong-but-valid cursor. `stateFor` (`rich-session.ts:187-199`) clamps deterministically; pin the exact anchor.

## apps/honeycrisp/src/lib/file-session.test.ts

Full-file specialist review : 50 tests, retain all; all cases and fixture paths considered.

- **Fake surface:** `disk()` has no dead members; every `Plan` kind is used. The `hold`/`defer`/`land` trio is what makes the races reachable, and an instantly resolving stub would not preserve them.
- **Retained regressions:** retry sends the original text and not newer typing (`:662-686`), reconcile on exact text sets no timer (`:717-746`), partial move blocks everything (`:1051-1067`), a stale review cannot save (`:598-610`).
- **Result checks needing helpers:** `.error?.name` at `:683,783,813,964` should use `expectErr`; `.error).toBeNull()` at `:726,1093,1192` should use `expectOk`.
- **`:1138-1140`:** the header "Acceptance repairs" names process history, not behavior. Rename it or fold it into "Unconfirmed saves".
- **`:840-856`:** re-implements `open(source, admits)` inline.
- **`:759-762,808`:** the same vacuous `x !== undefined &&` guard pattern.

## apps/honeycrisp/src/lib/note-source.test.ts

Full-file specialist review : 12 tests, retain, convert Result checks; all cases and fixture paths considered.

- **Result checks:** `applyRichBody` and `applyFields` return `Result<string,string>`. `.data` / `.error` / `!` at `:54,77,86,97,107,114,120,130` should use `expectOk`/`expectErr`.
- **`:137-144`:** named for preview text but also asserts three `displayTitle` cases. Split or rename.
- **`:147-157`:** tests `diffLines` from `line-diff.ts`, which the JSDoc does not mention and which has no test file of its own. Move it to `line-diff.test.ts` or add it to the doc.
- **Retained regressions:** byte-identical no-op (`:45-55`), CRLF kept (`:94-98`), comments and unknown keys kept (`:112-121`).

## apps/honeycrisp/src/lib/notes.folder.test.ts

Full-file specialist review : 61 tests, retain; one deletion candidate, one hedge; all cases and fixture paths considered.

- **Fixture challenge:** `product()` opens a real folder and repository per test. Replacing it with the memory disk from `file-session.test.ts` would lose the real conditional replace and create (true `Conflict`/`Exists` from the filesystem), mtime-untouched reads (`:268-283`), git lock behavior (`:400-426`), and the refresh-to-observe wiring. Resolution: keep the fixture.
- **Deletion candidate, medium confidence:** `:531-548`. Retained: `file-session.test.ts:446-462`, `typing during a save stays dirty after the submitted text is acknowledged`. Real replace success is covered at `:285-323`. Probe before cutting.
- **Other overlap with `file-session.test.ts` (keep):** `:1312`, `:1328`, `:1348` add a real late-landing `Conflict`.
- **`:1736-1767`:** see P0-6. "Parent counterexample:" is process jargon.
- **Result checks:** `:913,1183,1229,1323,1368,1413,1503,1531,1583,1600` should use `expectErr`; `:835` should use `expectOk`.
- **`:388-393`:** a pure `noteIdOf` test in a real-directory file that needs no fixture.
- **`:1680,1722,1814`:** single-tick negatives, same caveat as `close.test.ts`.
- **Tidy:** the three trailing tests at `:1735-1823` have no section header.

## apps/honeycrisp/src/lib/notes.test.ts

Full-file specialist review : 4 tests, retain, fix docs; all cases and fixture paths considered.

- **JSDoc `:1-12`:** lists two behaviors under "Notes Selection", but the file also covers open deduplication (`:129`), refresh coalescing (`:145`) and a removed binary (`:180`). Update it.
- **`:180`:** the name says it "keeps the selected missing-file screen", but the assertion is `selection` is undefined. Align the name with what is asserted.
- **`:88`:** the comment says "microtask" while the helper uses `setTimeout(0)`.
- **Retained regressions:** `:91-127` is a real Svelte teardown-dependency regression, explained at `notes.svelte.ts:218-227`. `:145-178` pins that listings never overlap.

## apps/honeycrisp/src/lib/platform-selection.test.ts

Full-file specialist review : 2 tests, retain; all cases and fixture paths considered.

- **Reaches production:** builds the real module graph per platform in a child process and asserts forbidden and required modules. Types cannot express this boundary.
- No changes.

## apps/honeycrisp/src/lib/platform/first-open.test.ts

Full-file specialist review : 10 tests, retain all; all cases and fixture paths considered.

- **Reaches production:** real directories and git for the invariants, and a `scripted` fake only for error mapping. Every branch of `first-open.ts:36-52` is reached, including the create race (`:241-264`) and the unknown-outcome write that is not retried (`:293-302`).
- **Weak negatives:** the 300 ms sleeps at `:144,160,181,216` are time-based. They are documented, and no cheaper honest alternative exists without a production seam.
- No changes.

## apps/honeycrisp/src/routes/components/AppHeader.test.ts

Full-file specialist review : 3 tests, retain; all cases and fixture paths considered.

- **Retained regressions:** stale reply ordering, close/reopen, and reply after disposal, against the abort guard at `AppHeader.svelte:63-77`.
- **Fixture challenge:** the harness is about 95 lines. It slices production source rather than copying it, and mounting the component or extracting a production module would cost more. Keep it.
- **Fragility:** any second `$effect`, or a renamed `open`/`log`, throws the `:80-83` guard. That is loud, which is acceptable.
- **Tidy:** the position guard is duplicated at `:42-48` and `:63-69`. The JSDoc has no "Key behaviors" list.

## packages/auth/src/account-lifetime.test.ts

Full-file specialist review : 15 cases, retain all; all cases and fixture paths considered.

- **Retained regressions:** Account identity across reauthentication (`:93-103`), a replaced Account is never revived (`:105-122`), shared verification survives one caller cancelling (`:153-178`), disposal during verification (`:203-237`), stream replay on 401 (`:256-279`), a real `Bun.serve` stream abort (`:281-334`), and bearer emission gated on verification (`:336-383`).
- **Fake surface:** `FakeSocket.close` and its event dispatch are reached through `create-session-auth.ts:327-334`.
- **JSDoc:** one line. Expand it to the convention.
- **`:233`:** `.error?.name` should use `expectErr`.

## packages/auth/src/account-management.test.ts

Full-file specialist review : 2 tests, retain; all cases and fixture paths considered.

- **Retained regression:** URL-shape contract with delimiter injection (`alice&expectedPrincipal=bob#other`).
- No changes.

## packages/auth/src/browser-redirect-auth.test.ts

Full-file specialist review : 5 tests, retain; all cases and fixture paths considered.

- **Retained regressions:** storage keys scoped per origin, a legacy cell cannot retarget the server, and the redirect URL shape (`:120-126`).
- **`:46-49`:** every test asserts `requests` is `[]`, so the fake's `Response.json({principalId:'alice'})` is never consumed. Replace it with a throw, so the no-network claim is enforced by the fake.
- **`:155-157`:** bare `rejects.toThrow()`. Pin `'own server'`.

## packages/auth/src/client-boundary.test.ts

Full-file specialist review : 2 tests, retain; all cases and fixture paths considered.

- **Retained regressions:** the JWT scan, and `'PersistedAuth' in authRoot` is false. The comment about the `exports` map is true (`package.json:7-11`).
- **`:91-92`:** these two lines prove an export exists, which the build owns. Delete them.
- **JSDoc:** one line.

## packages/auth/src/contract.test.ts

Full-file specialist review : 33 cases, retain; delete one, trim two lines; all cases and fixture paths considered.

- **Retained regressions:** verify before persist, join of duplicate starts and callbacks, status-to-state mapping (`:217-236`), stale verification cannot clear newer state (`:275-359`), 401 retry on a new revision (`:383-411`), header hygiene (`:428-446`), write ordering against revocation (`:509-571`), rollback on sign-out or dispose (`:600-633`).
- **Delete** `:260-273` (P1-8).
- **`:582`:** the no-op abort listener is dead.
- **`:92`:** redundant after `:91`.
- **`:573-598`:** assert the revoke carries `Bearer alice:2`; the request's `init` is already recorded.
- **`:448-483`:** waits the real five-second `AbortSignal.timeout` (`create-session-auth.ts:553`). It is the only test of the deadline; keep it and note the cost.

## packages/auth/src/desktop-broker-auth.test.ts

Full-file specialist review : 17 cases, retain; rewrite one, rename one; all cases and fixture paths considered.

- **Retained regressions:** body bytes preserved with authorization and cookie stripped (`:90-144`), cancel before dispatch (`:146-179`), a late header cannot republish (`:265-288`, `:390-416`), boot snapshot removed (`:338-358`), close barrier (`:418-446`).
- **`:49`:** named for unreadable credentials, but `createDesktopBrokerAuth` never reads `credentialUnreadable` (it is consumed in `apps/epicenter`). The test is the plain signed-out path; rename it.
- **`:290-308`:** a pass-through getter plus `toBeFunction()`. Rewrite it so the self-hosted origin drives the own-server check: `account.fetch('/x')` is brokered, and a cloud URL rejects with `'own server'`.
- **`:62`:** `toBeFunction()` is an existence check.
- **Result checks:** `:65,192,196,219-220,237,443-444` should use `expectOk`/`expectErr`.
- **Tidy:** `startup!` and `startup?.` on a non-nullable return are leftovers; use `using`. The helper at `:383` sits mid-file.

## packages/auth/src/instance-server.test.ts

Full-file specialist review : 3 tests, retain; all cases and fixture paths considered.

- **Retained regression:** `:25-29` pins the durable authority bytes against an independent literal.
- Optional: an `http:` positive case, and a message on the bare `toThrow()`.

## packages/auth/src/instance-token.test.ts

Full-file specialist review : 5 tests, retain; all cases and fixture paths considered.

- **`:25`:** the `>=` check is implied by `:24` and `:28`; delete it.

## packages/auth/src/persisted-auth-format.test.ts

Full-file specialist review : 2 tests, retain, rewrite first; all cases and fixture paths considered.

- **`:9-14`:** both sides are test-constructed through `JSON.stringify`, so it checks the schema library's identity behavior. Replace it with `serializePersistedAuth(cell)` compared against the literal `'{"token":"signed-session","principalId":"alice"}'`, then `parsePersistedAuth` back, so the persisted layout is pinned by production code.
- **`:16-29`:** a good runtime-validation table.

## packages/auth/src/persisted-auth-storage.test.ts

Full-file specialist review : 5 tests, retain; all cases and fixture paths considered.

- **Missing:** the positive web write. `set(value)` storing the serialized cell under `key` (`persisted-auth-storage.ts:35`) is not asserted in any assigned file.
- **Optional deletion** `:67-74`. Retained: `:16-26` (the parse catch branch) and `:52-65` (`initial` equals the cell, which proves the parse wiring).
- **Fake surface:** `MemoryStorage.length`, `clear` and `key` are interface-required only.

## packages/auth/src/read-api-session.test.ts

Full-file specialist review : 5 tests, retain, fix conventions; all cases and fixture paths considered.

- **No leading JSDoc.**
- **Result checks:** every test destructures `{data, error}`; use `expectOk`/`expectErr`.
- **`:40`:** named for 401/403 but only tests 401.
- **`:60`:** Malformed covers non-JSON only, not a schema mismatch.
- **`:34`:** `redirect: 'error'` (`read-api-session.ts:67`) is not asserted beside `credentials`.

## packages/auth/src/refusal-is-not-an-identity-change.test.ts

Full-file specialist review : 1 test, delete; all cases and fixture paths considered.

- See P1-7.

## packages/auth/src/session-authority.test.ts

Full-file specialist review : 3 tests, retain; all cases and fixture paths considered.

- **Retained regressions:** distinct authority per origin for equal principals, a non-Cloud callback gains no dashboard links, and the hosted composition keeps `'epicenter-api'` and the management URL.
- **`:67-69`:** bare `rejects.toThrow()`.

## packages/auth/src/session-handoff-client.test.ts

Full-file specialist review : 17 cases, retain all; all cases and fixture paths considered.

- **Reaches production:** a real Better Auth server with the `sessionHandoff` plugin over loopback. This is a high-value boundary, and the JSDoc states its limits.
- **Retained regressions:** the persisted cell holds only `version` after consume, strict callback matching (`:126-147`, with the final success proving the attempt was not burned), orphan revocation (`:203-266`, `:336-394`).
- **`:159-172`:** see P0-4.

## packages/client/src/hosted-blobs.test.ts

Full-file specialist review : 2 tests, retain, fix; all cases and fixture paths considered.

- **No leading JSDoc.**
- **Result checks:** `:35-36,48,64-65` should use `expectOk`/`expectErr`.
- **`:67-69`:** `delete` is `async`, so `expect(() => blobs.delete(…)).toThrow()` appears to pass only because Bun awaits the returned promise. It is also bare, so an invalid-URL throw would pass too. Use `await expect(blobs.delete(…)).rejects.toThrow('another principal')`.
- **Name:** covers three behaviors. No foreign-download or `TooLarge` case.

## packages/client/src/openai-provider.test.ts

Full-file specialist review : 11 tests, retain 10; all cases and fixture paths considered.

- **Retained regressions:** the request body shape, the index-correlated reducer, index-less parallel calls for the Gemini shape (`:306-377`), error-code mapping, pending tool calls discarded on error or abort (`:481-574`).
- **Delete** `:413-454` (P1-9).
- **Missing:** the `toParameters` defaults (`openai-provider.ts:78-90`: a missing schema, and a bare `{type:'object'}` gaining `properties` and `required`). The only tool fixture already has both. Bad-JSON arguments falling back to `{}` (`:124-131`) is also untested.
- **Docs:** JSDoc `:11` names a test that does not exist under that name. `:42` says "last request body" but all are recorded.
- **Tidy:** engine construction is repeated ten times; a small helper removes about 100 lines. `:406-410` could use a whole-array `toEqual`, as `:510` does.

## packages/constants/src/ai-providers.test.ts

Full-file specialist review : 2 tests, retain; all cases and fixture paths considered.

- The fallback is the runtime contract. The known-id test keeps an identity function from passing.

## packages/constants/src/app-data.test.ts

Full-file specialist review : 18 tests, retain; all cases and fixture paths considered.

- **Retained regressions:** the platform table, refusal of a relative override, and the bundle-identifier pin against `tauri.conf.json` (`:117-138`, a real cross-process contract).
- **`:159`:** the name says "not one lowercase segment", which contradicts the reverse-domain grammar. Rename it.
- **Delete** the `isAppId` lines at `:155,172` (P1-13).
- **`:52-56`:** takes the same branch as `:46-50`. It is cheap; keep or fold.

## packages/constants/src/app-id.test.ts

Full-file specialist review : 6 tests, retain all; all cases and fixture paths considered.

- The JSDoc states the unique property (reverse domain is required, not incidental). No changes.

## packages/constants/src/provider-credentials.test.ts

Full-file specialist review : 5 tests, retain all; all cases and fixture paths considered.

- Pins the env-name wire convention, including no leak across environments and empty counting as missing. No changes.

## packages/definition/src/addresses.test.ts

Full-file specialist review : 5 tests, retain, largest gap in the batch; all cases and fixture paths considered.

- **No leading JSDoc.**
- **`:50-57`:** named "bounded in bytes, not characters", but uses ASCII only, and all three grammars are ASCII-only, so bytes and characters cannot differ through these predicates. The comment at `:54-55` (a two-byte character is admitted) is false against `ROW_ID_PATTERN`. Rename it to a ceiling test; add the data-id ceiling and a positive table-name case at the limit.
- **Untested:** the `sqlite_` prefix and case-insensitive keyword refusal (`addresses.ts:153-154`). Only `'order'` is checked.
- **Keyword re-derivation:** see P0-5.

## packages/definition/src/compile.test.ts

Full-file specialist review : 3 tests, retain; all cases and fixture paths considered.

- Uses `expectOk`/`expectErr` and `@ts-expect-error` correctly. The cross-referenced `packages/app/src/data/definition/compile.test.ts` exists.
- **Uncovered Malformed branches** (in this file or, by name, the sibling): invalid id, reserved or case-colliding table names, declared `default`, a field named `id` (`compile.ts:125-166,220,348`).

## packages/definition/src/field/field.test.ts

Full-file specialist review : 81 generated cases, retain 77; all cases and fixture paths considered.

- **Retained regressions:** the round-trip loop, the canonical loop, the at-rest wire pins (`:84-97`), the reference minimum-length floor (`:322-339`), UTF-8 byte bounds (`:366-377`), and the 17-entry rejection lane.
- **Delete** `:173-176`, `:191-193`, `:293-297`, `:299-301` and padded `:132-133` (P1-10).
- **Overlap:** `:286-291` duplicates the round-trip except for `rest['x-ref']`; keep only that line.

## packages/device/src/browser-sqlite.test.ts

Full-file specialist review (1 case): keep; all cases and fixture paths considered.

- **Keep:** laziness (`:27`), one worker shared across apps with ids `[0,1]`, failure fan-out, and the retired-worker guard (`browser-sqlite.ts:58`). Removing the guard settles `replacement` before `:43`, so the failure is reachable. Every fake member is used.
- **Gap:** the worker `failure` answer (`browser-sqlite.ts:77`) and a throwing `postMessage` (`:87`) are not exercised.

## packages/device/src/desktop.test.ts

Full-file specialist review (4 cases): keep; all cases and fixture paths considered.

- **Keep:** `:99` pins `wss://epicenter.test/api/device/sqlite` and the frame kind order. `:138` and `:164` gate `acquire`/`run` so the late host work must drain before reacquire succeeds. `:204` rejects an unknown response id.
- **Change:** item 17. `calls.push('delete')` (`:48`) and `onerror` (`:60`) are never exercised; `delete` is interface-required, the recording is not.

## packages/device/src/owner.test.ts

Full-file specialist review (19 blocks, 22 cases): keep, clean up; all cases and fixture paths considered.

- **Keep:** gated-open and gated-statement close drains (`:155`, `:182`), failed cleanup keeping the claim (`:90`, `:111`, `:207`, `:228`), connection-token replacement under a gated open (`:322`), query cancel bypassing the queue (`:408`), and release-before-drain (`:499`).
- **Change:**
  - `:62` and `:316-318`: bare `rejects.toThrow()`; match `'closed'` and `'is not valid'`.
  - `:273`: named "a delayed statement…" but nothing is delayed. Rename to "a handle retained across delete never reaches the backend".
  - The transport wrapper is repeated at `:276`, `:333`, `:355`, `:392`, `:429`; extract `remoteOver(dispatch)`.
  - Items 13 and 14.

## packages/folder/evidence/bundles/bundles.test.ts

Full-file specialist review (5 cases): keep; all cases and fixture paths considered.

- **Keep:** real Vite output against the README alias contract; positive controls exist for `DESKTOP`, `BROWSER`, `GIT`, `SHELL`.
- **Change:**
  - `Built.chunks` and `Built.closure` are never used by any test.
  - `:163-165`: the negatives for `'isomorphic-git'`, `'epicenter-folder-files:'` and `'indexedDB'` have no positive control. Assert all three are present in the browser-alias build at `:147`.
  - `:149` is subsumed by `:150`.

## packages/folder/src/batch.test.ts

Full-file specialist review (14 blocks, 21 cases): keep; all cases and fixture paths considered.

- **Keep:** standalone-vs-batched refusal parity (`:324`), plan-order name freeing on a real case-insensitive directory (`:385`), and the real `Partial` and recovery (`:637`, `:690`).
- **Change:**
  - `:169` combines two `isFrozen` checks into one boolean; split and include `steps[0].file`.
  - `:196-203` re-asserts frozen values already equal at `:151`; trim to the Conflict checks at `:212-218`.
  - `:585` (the empty batch) is unrelated to its test's name.
- **Low priority:** `:348` returns before publication and could run once under "batch admission". The retained native path is `:324` on the directory fixture.

## packages/folder/src/browser.test.ts

Full-file specialist review (19 cases): keep most; all cases and fixture paths considered.

- **Result helpers:** `:88-117`, `:126-157`, `:170-202`, `:331-353`, `:386-397`, `:414`, `:421`, `:447`, `:533`, `:549`, `:673`.
- **Unchecked setup saves:** `:122`, `:164-169`, `:375`, `:379`, `:657`.
- **Other:** items 4, 8, 11. `:69` is a stale duplicate comment. `:163` has an invisible BOM inside the literal; use `\uFEFF`.

## packages/folder/src/close.test.ts

Full-file specialist review (9 cases): keep; all cases and fixture paths considered.

- **Keep:** `held()` wraps the real browser boundary and backend with gates, so "close resolves while a begun apply is pending" (`:195`) and "close waits for an admitted commit" (`:239`) are reachable.
- **Change:** item 10. `real` and `base` are returned and never used.

## packages/folder/src/entries.test.ts

Full-file specialist review (7 cases): keep; all cases and fixture paths considered.

- **Keep:** no fallback to IndexedDB inside the shell (`:124`, `:159`), the default author literal (`:211`), and the `AuthorRequired`/`InvalidId` refusals.
- **Change:** `:105-107` is structural and already covered by behavior in `:110` and `:159`. `:245-249` is the weaker form of `observers.test.ts:361`.

## packages/folder/src/files.test.ts

Full-file specialist review (10 blocks, 18 cases): keep; all cases and fixture paths considered.

- **Keep:** "nothing is read back" (`:433`, `:454`) uses a real boundary with a race hook; the throwing `unused` history members are honest.
- **Change:** `:348` asserts only that a function is returned; say what it means or drop it. `base` at `:408` is unused. `:314` joins two unrelated behaviors in its name.

## packages/folder/src/git/attributes.test.ts

Full-file specialist review (4 blocks, 15 cases): keep; all cases and fixture paths considered.

- **Keep:** parity with real `git check-attr --source` across 12 fixtures.
- **Change:**
  - `:341` re-runs all 12 Git fixtures only to count verdicts; use `ownVerdicts`, which the parity cases already prove equal.
  - `:95` asserts `isAttributesPath` on keys the test wrote, with no negative; make it one explicit test with `'x.gitattributes'`.
  - `:367` claims "whichever way Git would read it" but asserts one reading; add a `'\uFEFFa.wav'` path. `:369` embeds an invisible BOM.

## packages/folder/src/git/history-attempt.test.ts

Full-file specialist review (26 cases): keep 24; all cases and fixture paths considered.

- **Keep:** all `probe` and `holds` members are used; the held-CAS, held-lock and held-transport gates make each "did not happen and is not made up later" claim reachable.
- **Change:** items 2, 5, 9. Result helpers at `:196`, `:424`, `:602`, `:640`, `:836`, `:983-985`.

## packages/folder/src/git/history-ordering.test.ts

Full-file specialist review (9 blocks, 11 cases): keep 10; all cases and fixture paths considered.

- **Keep:** the capture-inside-lock regression (`:120`), receipt-survives-observation-failure (`:370`, `:427`), and the three partial-pull outcomes.
- **Change:** item 3. The `commitGate` override in the first `setup` (`:185-188`) is never reached there. `:239` should be `test.each`. Result helpers at `:88`, `:200-202`, `:218`, `:229`, `:285-288`, `:304`. The JSDoc omits `:370-506`.

## packages/folder/src/git/history.test.ts

Full-file specialist review (2 cases): keep; all cases and fixture paths considered.

- `:73` should use `expectOk`.

## packages/folder/src/git/runner.test.ts

Full-file specialist review (12 cases): keep; all cases and fixture paths considered.

- **Change:** `:282-283` use `toBeDefined()`; assert the reason text. The "commit subjects" block tests `messages.ts`, not the runner; moving it is optional.

## packages/folder/src/incoming-attributes.test.ts

Full-file specialist review (4 blocks, 8 cases): keep all; all cases and fixture paths considered.

- The store and directory dumps before and after a refused pull are what detect a partial write.

## packages/folder/src/index-reconcile.test.ts

Full-file specialist review (3 cases): keep all; all cases and fixture paths considered.

- `:111` is an unchecked save.

## packages/folder/src/kv.test.ts

Full-file specialist review (19 blocks, 36 cases): keep; all cases and fixture paths considered.

- **Keep:** the counting storage makes "reads once, applies once, no retry" and the owned-values race reachable.
- **Change:** `:101-117` hand-builds an Io error and casts; use `{ ...storage, read: () => FileError.Io(...) }`. `:357` parses the test's own literal; parse `updated.source` instead. `:307` is implied by `:305`.

## packages/folder/src/markdown.test.ts

Full-file specialist review (21 cases): keep; all cases and fixture paths considered.

- **Result helpers:** `:66-67`, `:73`, `:80`, `:87-88`, `:94-95`, `:101`, `:106`, `:113`, `:120`, `:134-137`, `:172`, `:178`.
- **Other:** `:124-126` passes on any refusal; assert `'flow mapping'`. `composeSource` (`:129`) sits under `describe('patchSource')`.

## packages/folder/src/native-capture.test.ts

Full-file specialist review (3 cases): keep all; all cases and fixture paths considered.

- The module is imported after `mock.module`, so `readFile`/`readdir` hooks bind; `overlapped` is true only if ordering regresses.

## packages/folder/src/native-concurrency.test.ts

Full-file specialist review (5 cases): keep all; all cases and fixture paths considered.

- The `firstWon` branches at `:167` and `:203` are legitimate because hashing precedes the ordered `apply`. Exactly-one-success is asserted, so lost serialization fails.

## packages/folder/src/native-publication.test.ts

Full-file specialist review (10 cases): keep 9, one user decision; all cases and fixture paths considered.

- **`:166`** asserts the documented data-loss window. Only a fix would make it fail, so it is a characterization, not a regression detector. Keep it as a deliberate doc pin or move it to `evidence/`.
- **Result helpers:** `:136`, `:155`, `:183`, `:197`, `:223`, `:301-304`, `:337-338`.

## packages/folder/src/native-safety.test.ts

Full-file specialist review (13 blocks, 14 cases): keep; all cases and fixture paths considered.

- **Change:** item 12. Result helpers at `:88`, `:123-136`, `:165`, `:170`, `:206-217`, `:228`, `:261`. Unchecked fixture calls at `:203-205` and `:212-214`.

## packages/folder/src/native.test.ts

Full-file specialist review (10 cases): keep; all cases and fixture paths considered.

- **JSDoc:** two lines for a 469-line file; add the behavior list.
- **Change:** `:37-39` re-declares `openNativeFolder` from `directory.test-support.ts`. Result helpers and `.data!` throughout (`:88-118`, `:214-215`, `:314-325`, `:370-431`). `:332` also asserts `Dirty` and `Diverged`, which the name omits.

## packages/folder/src/observers.test.ts

Full-file specialist review (9 blocks, 15 cases): keep; all cases and fixture paths considered.

- **Change:** `:142-144` is a hedged commit status; drop it and keep `:145`. The channel fake logs `'constructed'`, `'listening'` and `'posted'`, which nothing reads.

## packages/folder/src/ownership.test.ts

Full-file specialist review (5 cases): keep; all cases and fixture paths considered.

- **JSDoc bullet 2 is truthless:** siblings appearing after capture are tested in `browser.test.ts:205`, not here.
- **Change:** `:126` "…and nothing else decides" is vague; it is the only stale-`delete` test, so name it that. `:180-192` duplicates `table.test.ts:243`. Result helpers at `:137-141`, `:154-192`, `:199-208`.

## packages/folder/src/source-scope.test.ts

Full-file specialist review (4 cases): keep all; all cases and fixture paths considered.

- Result helpers at `:70`, `:106-118`, `:140`, `:184-208`. Unchecked saves at `:102`, `:109`, `:134`, `:137`, `:181`, `:191`.

## packages/folder/src/table.test.ts

Full-file specialist review (11 cases): keep all; all cases and fixture paths considered.

- The hooked real boundary reaches the read-to-apply race, `Unconfirmed` without replay, and no-readback. No changes.

## packages/folder/src/tauri-native.test.ts

Full-file specialist review (15 cases, all skipped without `EPICENTER_FOLDER_BRIDGE=1`): keep; all cases and fixture paths considered.

- The alternates at `:588`, `:665` and `:854` are real cross-process races with exact follow-up assertions. The `failure` helper duplicates `tauri.test.ts:585`.

## packages/folder/src/tauri.test.ts

Full-file specialist review (31 blocks, 32 cases): keep; all cases and fixture paths considered.

- **Keep:** scripted replies protect real decisions: `Unconfirmed` against `Io`, send-once, withdraw exactly once, sequence ordering, no push after an unknown commit.
- **Change:**
  - Item 6.
  - `:445-454` sets a read reply and asserts it back; keep only `isFrozen`.
  - `:574-575` should use `expectErr`.
  - `:1095` also asserts push mapping its name omits.
  - `untilSent` (`:113`) is unbounded and hangs instead of failing.

## packages/folder/src/terminal.test.ts

Full-file specialist review (17 blocks, 28 cases): keep; all cases and fixture paths considered.

- **JSDoc:** omits the six injected-race tests at `:254-454`.
- **Contract question:** `:421` pins that `exec` rejects on `EEXIST`, while the `failure` helpers in the tauri tests accept either a result or a throw.

## Final implementation resolutions

Every assigned file was read in full by a bounded read-only specialist against a frozen source snapshot, including all cases, shared setup, cleanup, and production paths. Codex directly reviewed the proposed changes and material source contracts. Review result files record specialist case counts; all 121 exact paths occur above. Candidate lists are proposals, not automatically accepted changes.

Accepted implementation changes after source adjudication:

- Session handoff client duplicate completion now records client fetch requests and requires exactly one redemption. One-use server session count alone could hide duplicate client sends.
- Persisted session roundtrip now calls production serialization/parsing and pins an independent literal JSON cell, replacing JSON.stringify of a test-constructed object on both sides.
- Hosted blob deletion uses an awaited rejection with the owner-specific message and confirms no extra request reached transport.
- Honeycrisp refuses an editor while a noneditor change is in flight and after its uncertain reply. The test now asserts no session on both sides instead of conditionally testing whichever outcome appeared.
- Rich-session cursor replacement now pins the actual clamp position 2 instead of accepting any earlier cursor.
- Native close requires the external version to exist before asserting that the input fence rejects taking it.
- Note-source assertions use Result helpers; docs include preview/title/diff behavior. Notes state docs and removed-binary test name now match the selected-path/absent-selection behavior actually asserted.
- Strict trigger-eval uses a disposable unowned phrase corpus, so improving the shipped corpus cannot break the gate test. Consultation nonrepository fixture lives outside the initialized parent repo and pins the actual standalone-clone error. Refusal exits are exactly 1, excluding timeout/null false passes.
- Tauri protocol refusal now uses host4/page3 matching actual sent page3 and asserts both mapped values; previous fake incorrectly labelled page2 and included same-host3 as incompatible.
- KV JSON validity assertion parses the production updated source instead of the expected test literal.
- Browser and observer terminal/save scenarios retain unconditional final-clean-status assertions and drop timing-dependent committed/unchanged outcome acceptance. Existing lastCommit/real-log checks remain.

Only one test block was deleted: raw-SQL interrupted publication in local-blob-store.test.ts. The retained named “local publication, media reads, access, ranges, deletion, and reopening” test exercises production put, occupied-key conflict, exact bytes across reopening, and deletion absence. The removed fixture rolls back its own INSERT in its own transaction and cannot expose a change in production put, which has no such transaction. Its Database import disappears. Provider key-order assertion was also removed: retained exact registry object equality detects missing/extra providers and incorrect credentials without imposing undocumented insertion order.

Other proposed whole-file or scenario deletions were declined. Exploratory initialization evidence remains documented as a prototype. Historical principal-helper tests remain with truthful historical documentation. Digest CONTROL remains because the local digest string helper could become constant and silently make the retained 8MB transfer comparison vacuous. Real filesystem, Git, WASM, browser bundle, WebAuthn, Postgres, and workerd scenarios remain.

Validation evidence:

- Baseline root script failure in old OAuth callback family fixed only after git commit 23bade0df4 confirmed route ownership was intentionally removed; current /api positive match test remains.
- Baseline foundation cache prefix mismatch fixed after reading real device fixture definition so the independent literal matches app ID firstopen.
- Server Workers configured baseline: 8 files, 32 tests passed.
- Enrollment admission workerd evidence: 18 tests passed. Production enrollment config fails import before tests on pg-protocol ESM/CommonJS; no test assertion changed to hide it.
- Folder real native bridge opt-in: 15 tests passed. Folder emitted-bundle/import-closure evidence: 7 tests passed.
- Honeycrisp native package command: build succeeds, 56 Rust tests pass, 3 fail before JS tests on obsolete mutation variant write. Separately built existing close-gate harness and JS native close suite passes (25 expanded cases; later combined final Honeycrisp run passes118 tests).
- Final focused suites pass: agent scripts56, folder102, Honeycrisp/native118, auth/client21, server/sqlite/scripts46, separate Results11 and evidence/address15. Counts overlap; do not add them as a unique total.
- Formatting only32 assigned changed test paths passed; git diff --check passed. Per-package final typecheck logs recorded separately.


Final typechecks: auth, client, definition, folder, server (src and workers), sqlite and both Honeycrisp builds all pass. Client initially exposed wellcrafted expectErr generic inference for a union of separately inferred Err arms; derive its generic from NonNullable<typeof refused.error>, with no cast or production edit, then rerun client typecheck and both blob tests successfully.
