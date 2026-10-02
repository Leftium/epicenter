Testing deletion grill: shared packages and documentation gates

All cases in the following 25 files were read, including generated/table-driven groups. Root baseline workspace execution and focused baseline principal execution precede changes. No production changes remain.

## packages/capture/src/compose.test.ts

Challenge: open-fence-only composition duplicates document.test.ts's final open-fence test with the same input, literal body, parser and refusal condition. Response: retain the document test, adding its one missing thoughts-empty assertion; it already asserts refusal undefined and absorbed true. Resolution: delete the duplicate case, keep three composition cases for ordinary multi-line inputs, pasted own-list plus open-fence marker, and real legacy import boundary. Header now points to the retained owner.

## packages/capture/src/document.test.ts

Retain parser/refusal matrix and every edit operation: literal expected bytes detect CRLF/BOM/whitespace or wrong-span losses; stale object identity covers equal text/index across generations and either swap operand. Add empty-thoughts assertion to retained open-fence case and correct stale-generation documentation. Helpers unwrap local Edit unions, not Wellcrafted Results.

## packages/capture/src/legacy/legacy.test.ts

Retain real memory-store export and filesystem import, each retry mode, receipt failure, late thought grouping, unreadable body, malformed receipts and independent account paths. They expose distinct persistent layouts and failure ordering, not repeated happy paths. Replace optional Result reads with expectOk/expectErr so acquisition/read failures cannot become defaults before assertions. Literal imported bytes remain independent of render output.

## packages/matter-core/src/core/conformance.test.ts

Retain all classification cases: required/optional nullish paths differ, invalid values and extras have independent row-validity implications; batch classification tests mixed validity. Add truthful leading contract JSDoc.

## packages/matter-core/src/core/contract.test.ts

Retain parser versus validator distinction, palette degradation, optional/searchable policy errors, and partial view errors; these are different unsafe-input gates. Use expectErr for Wellcrafted validator failures, preserving direct parsed-contract union checks. Add leading JSDoc.

## packages/matter-core/src/core/expected.test.ts

Retain scalar, reference, select and multiSelect serialization: reporter boundary consumers need independent expected literals. Real recognized field construction prevents isolated object-to-itself assertions. No edits.

## packages/matter-core/src/core/integrity.test.ts

Retain composed real table reads: conformance widening, typed/untyped target resolution, dangling/absent/unreadable targets, dual source/target roles, unreadable-file location and extras pin distinct assessment decisions. Similar lower-level cases do not cover this cross-table composition. No edits.

## packages/matter-core/src/core/parse.test.ts

Retain exact frontmatter framing, mapping/null restrictions, YAML 1.2 Norway input, conflict marker body boundary and extra document failures. Replace manual/optional Wellcrafted reads with expectOk/expectErr. The parser-cause assertion now requires InvalidYaml before checking cause, so an alternative error cannot skip it. Add JSDoc.

## packages/matter-core/src/core/query.test.ts

Retain both SQL-shape and real SQLite behavior: shape checks diagnose quoting/ranking while execution proves row filtering and apostrophe escaping. Replace leaking freshDb calls with per-case setup plus cleanup-only afterEach. Reuse the same projection for match/filter assertions. Database.dispose closes strictly and failed with FTS active statements on Bun 1.3.14; explicit Database.close() cleanup passed without weakening assertions. Add JSDoc.

## packages/matter-core/src/core/serialize.test.ts

Retain literal empty framing and value-preservation edit cycles. Both sides of the no-op identity test formerly read optional data and could compare undefined to undefined if parsing broke. Require expectOk on every parse; all existing expected values/order/body assertions remain. Add JSDoc.

## packages/matter-core/src/core/sqlite.test.ts

Retain schema/tuple wire contracts, storage/null/raw conversion, FTS creation and removal, real SQLite word matching and bundled cross-table joins. Different mechanism coverage earns overlap. Add fresh-database setup and cleanup-only afterEach; no database resources remain held after failures. Add JSDoc.

## packages/matter-core/src/core/table.test.ts

Retain real mixed readable/unreadable rows, typed conformance, optional absent/null and invalid-contract degradation. Reader composition can regress independently from parser/classifier functions. Add JSDoc.

## packages/matter-core/src/core/view.test.ts

Retain closed-shape typo/query cases, slug/duplicate ID gate, per-entry degradation, kind-specific grouping and nullish buckets. These exercise real branches. No splitting: one shared concern and fixture under 500 lines. No edits.

## packages/matter-core/src/core/violations.test.ts

Retain all real assessed-cell projection and summary cases. Deduped missing-target and per-row dangling differ; structural unresolved columns can leave rows ready, unlike dangling cells. Unreadable tables/files and extras map to separate output contracts. No edits.

## packages/matter-core/src/field/field.test.ts

Retain builder roundtrips, independent canonical schemas, exclusive meta checks, collision pairs, refinements, runtime UTF-8 bounds and unsupported schemas. They protect serialized schemas and external validation behavior. Remove two contain assertions already strictly implied by exact thirteen-kind equality in the same case; no scenario deletion. All generated kinds and unsupported groups considered.

## packages/matter-core/src/load/fs.test.ts

Challenge: 'an unmarked folder yields just its marked children, sorted' repeats 'a container loads its marked children, sorted, and skips unmarked sibling dirs'. Response: the retained case uses the same unmarked root, children, out-of-order creation and loose README, plus an unmarked sibling with Markdown. Resolution: delete the narrower duplicate. Keep typed/untyped loading, file selection, missing directories, marked-parent XOR, hidden children and bundled pipeline cases; real filesystem cleanup is already finally-protected.

## packages/matter-core/src/report/exit-code.test.ts

Retain exact numeric clean/problem/fatal literals and fatal precedence over real assessed data. Exit status is an external contract not owned by TypeScript. No edits.

## packages/matter-core/src/report/format.test.ts

Retain scalar/enum expected phrases, located diagnostics, extras-as-notes, exact clean rollup and unreadable-file rollup. Real assess results prevent a fixture-only echo. No edits.

## packages/principal/src/device-owner.test.ts

Retain independent hex address literals, account/authority/case separation and traversal/noncanonical inputs. These are persistent names and safety boundaries; bare constant appearance is not a deletion rationale. Both baseline tests pass. No edits.

## packages/recorder/src/vad-recorder.test.ts

Retain failed engine destruction with actual stream service spy: track stop, retained owner refusing start, successful retry and subsequent idle detect separate cleanup stages. Deferred fake unnecessary for synchronous failure contract, spy restoration already finally-protected. No edits.

## packages/svelte/src/from-data.svelte.test.ts

Retain all table projection/identity/point-read/write/body/nonconformance cases, which catch real adapter decisions. Strengthen KV and persistence fixtures to count delivered invalidations: imperative current reads alone would pass if subscriptions stopped notifying. Activate/deactivate source subscriptions around assertions. Fake Result-like update bodies are plain fixture objects, not Wellcrafted Results.

## packages/svelte/src/from-subscription.svelte.test.ts

Challenge: 'subscription detaches' asserted only subscription count, so missing teardown passed. Response: preserve the lifecycle promise with explicit unsubscribe and delivered-update counters. Resolution: keep all four cases and assert active source notifications, one cleanup and no notification after deactivation. Add truthful leading JSDoc. Temporary production defect replacing unsubscribe with a no-op fails the intended teardown case; probe restored immediately.

## packages/svelte/src/persisted-map.svelte.test.ts

Challenge: successful-write recovery reread the same stored dark value, so a permanently unwritten key would pass. Response: after confirmed write, change backing storage to light before focus. Resolution: retain all three refusal/recovery cases and require light after focus. Temporary production defect omitting successful-write unwritten.delete fails this assertion; probe restored immediately.

## scripts/check-doc-hygiene.test.ts

Retain subprocess/Git boundary and six distinct clean/terminal/proposed dependency cases. Stale header incorrectly claimed every ADR was Accepted and named age as a defect; replace with the actual proposal dependency contract. Test-only Git fixtures need real commits/tracked files because the gate queries Git history and index.

## scripts/check-doc-paths.test.ts

Retain twelve real subprocess/index cases: root paths/extensions/line suffixes, untracked targets vs untracked docs, historical exclusions and one-line/file exclusions differ. Cleanup already finally-protected. No edits.
