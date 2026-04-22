# Workspace Logger — JSONL, Local, DI

**Date**: 2026-04-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/document-primitive (or successor)

## Overview

Add a minimal logger to `@epicenter/workspace` that library modules use in place of direct `console.warn` / `console.error` calls. Default behavior matches current (console-only). Opt-in: a JSONL file sink (Bun-backed, streaming appends) routed via dependency injection — no global state, no library-owned paths.

## Motivation

### Current State

Library modules call `console.*` directly:

```ts
// packages/workspace/src/document/materializer/markdown/materializer.ts
console.warn('[markdown-materializer] table write failed:', error);

// packages/workspace/src/document/materializer/sqlite/sqlite.ts
console.error('[attachSqliteMaterializer] Failed to sync SQLite materializer.', error);

// packages/workspace/src/document/on-local-update.ts
console.error('[onLocalUpdate] callback threw:', err);

// ... 14 sites total across workspace + filesystem
```

This creates problems:

1. **Information loss.** Warnings scroll off the console; there's no history. If a background observer fails overnight, there's no record by morning.
2. **Test output pollution.** Every test that triggers a failure path spams the test reporter.
3. **No structured routing.** Tauri apps using `toastOnError` on typed errors get nothing for background failures — those only go to dev tools.
4. **No aggregation or query.** Apps that want to answer "show me errors from yesterday" or "all validation failures this week" have no primitive.
5. **Dev/prod symmetry broken.** Dev sees warnings; production drops them.

### Desired State

Library modules emit structured events via an injected logger. Default: console (same as today). Opt-in: JSONL file append, streamed via Bun's native `FileSink`. Caller picks the path — matches `attachSqlite`'s caller-picks-filePath convention.

```ts
const factory = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const log = createLogger('opensidian',
    jsonlFileSink(join(DATA_DIR, '.log.jsonl')));

  const markdown = attachMarkdownMaterializer(ydoc, { dir, log });
  const sqlite   = attachSqliteMaterializer(ydoc, { db, log });

  return { ydoc, markdown, sqlite, /* ... */ };
});
```

Result: JSONL tail-able in real time, structured errors preserved (defineErrors fields flow through), console still works as before. No global state.

## Research Findings

### What similar libraries do

| Library                    | Logger shape                                     | Transport / sink model       |
| -------------------------- | ------------------------------------------------ | ---------------------------- |
| Pino                       | `log.info(obj, msg)` — object first              | Pluggable transports         |
| Winston                    | `log.log({ level, message, ...meta })`           | Transport array              |
| Bunyan                     | Structured events, level-keyed                   | Stream-based                 |
| `console.*`                | Variadic, unstructured                           | Stdout/stderr                |
| y-websocket / y-webrtc     | No logger — `console.warn/error` directly        | N/A                          |

**Key finding**: Yjs providers consistently use direct `console.*`. That's the baseline. Pino/Winston are heavyweight for library code; for in-library logging the right shape is closer to console's ergonomics with structured output preserved.

### Bun-specific I/O

`Bun.file(path).writer()` returns a `FileSink` that:
- Buffers writes internally (fast repeated `.write()` calls)
- Exposes `.flush()` and `.end()` for shutdown
- Is append-friendly (though the semantics are "open and write" — for true append-mode, consider `open(..., 'a')` from `node:fs/promises`)

**Decision point**: use `Bun.file(path).writer()` for Bun/Node 21+ runtimes; fall back to `fs.appendFile` per-line for broader Node compat. Bun writer is preferable when available (no per-line reopen cost).

### Why not sync logs via CRDT

Briefly considered and rejected. Logs are:
- High volume (thousands of entries per session)
- Per-device diagnostic (not domain data)
- Retention-sensitive (rotate/delete, not preserve-forever)

Syncing them via Yjs would flood the CRDT with transient operational data. Logs stay **local to the device that produced them**.

## Design Decisions

| Decision                                  | Choice                                          | Rationale                                                          |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| Location of log file                      | **Caller decides** via explicit path            | Matches `attachSqlite({ filePath })`; no hidden convention         |
| Shape of `LogEvent`                       | `{ ts, level, source, message, data? }`         | Five essential fields; drop was not essential.                     |
| Unified `data` field (vs separate `context`/`error`) | Single `data: unknown`                | Errors aren't special — sinks handle serialization                 |
| Log levels                                | `'debug' | 'info' | 'warn' | 'error'`            | Four levels covers every real use                                  |
| Global sink registry                      | **No**                                          | DI only; no hidden state                                           |
| Library-wide "default logger"             | **No**                                          | Each attach primitive takes an optional `log` option               |
| Default when no logger passed             | Console sink (matches current behavior)         | Zero-config, backward compatible                                   |
| JSONL format                              | One JSON object per line, `\n` terminated       | Grep-able, tail-able, jq-compatible                                |
| Timestamp format in JSONL                 | ISO 8601 string                                 | Sortable, human-readable, timezone-explicit                        |
| Error serialization                       | JSON.stringify + flatten native `Error` objects | `defineErrors` errors are already structured; native Errors need `name`/`message`/`stack` extraction |
| Rotation                                  | Out of scope                                    | Caller rotates; if it becomes a real problem, add later            |
| Remote / HTTP sinks                       | Out of scope                                    | Apps integrate their own observability stack via custom sinks      |
| Browser fallback                          | Console sink only                               | No filesystem; `jsonlFileSink` is Bun/Node-only by import path     |

## Architecture

### Type shape

```
┌─────────────────────────────────────────────────────┐
│ LogEvent                                            │
│   ts:      number       ← epoch millis              │
│   level:   LogLevel     ← 'debug'|'info'|'warn'|'error' │
│   source:  string       ← from createLogger()       │
│   message: string       ← human text                │
│   data?:   unknown      ← anything; sink serializes │
└─────────────────────────────────────────────────────┘
                    │
                    ▼  emitted via
┌─────────────────────────────────────────────────────┐
│ LogSink = (event: LogEvent) => void                 │
└─────────────────────────────────────────────────────┘
                    │
                    ▼  constructed by
┌─────────────────────────────────────────────────────┐
│ consoleSink                   ← default; ships in   │
│ jsonlFileSink(path)           ← Bun file writer     │
│ memorySink()                  ← for tests           │
│ <custom>                      ← any (event) => void │
└─────────────────────────────────────────────────────┘
```

### Caller flow

```
STEP 1: Construct sink(s) at app startup or build-closure time
────────────────────────────────────────────────────────────────
  const sink = jsonlFileSink(join(DATA_DIR, '.log.jsonl'));

STEP 2: Create a Logger from source + sink
────────────────────────────────────────────────────────────────
  const log = createLogger('markdown-materializer', sink);

STEP 3: Pass the logger to library primitives via `log` option
────────────────────────────────────────────────────────────────
  const markdown = attachMarkdownMaterializer(ydoc, { dir, log });

STEP 4: Library emits structured events
────────────────────────────────────────────────────────────────
  log.warn('table write failed', { path, error });
  → sink receives: { ts, level: 'warn', source: 'markdown-materializer',
                     message: 'table write failed',
                     data: { path, error } }
  → consoleSink writes to stderr with formatted prefix
  → jsonlFileSink appends one JSON line

STEP 5: Caller closes sinks on shutdown (Bun/Node apps)
────────────────────────────────────────────────────────────────
  process.on('beforeExit', () => sink.close());
```

### File layout

```
packages/workspace/src/shared/logger/
├── index.ts                  ← barrel
├── logger.ts                 ← createLogger, Logger type, LogEvent, LogLevel
├── console-sink.ts           ← consoleSink (default)
├── jsonl-sink.ts             ← jsonlFileSink (Bun/Node only)
├── memory-sink.ts            ← memorySink (for tests)
└── logger.test.ts            ← fixture-based tests
```

## Implementation Plan

### Phase 1 — core logger module

- [ ] **1.1** Create `packages/workspace/src/shared/logger/logger.ts`:
  - Export `LogLevel`, `LogEvent`, `LogSink`, `Logger` types
  - Export `createLogger(source: string, sink?: LogSink): Logger`
  - Default sink parameter: `consoleSink`
- [ ] **1.2** Create `console-sink.ts` with the default console sink that matches current `console.*` behavior (prefix, level-appropriate method, error objects pretty-printed)
- [ ] **1.3** Create `memory-sink.ts` — a sink that pushes events to an array (returned by the factory for test inspection)
- [ ] **1.4** Export from `packages/workspace/src/index.ts`
- [ ] **1.5** Tests: emits events through sinks, levels work, source prefix correct, native Errors get `.name`/`.message`/`.stack` preserved, defineErrors objects flow through unmodified

### Phase 2 — JSONL sink (Bun-backed)

- [ ] **2.1** Create `jsonl-sink.ts`:
  - `jsonlFileSink(path: string): LogSink & { close(): Promise<void> }`
  - Open a `Bun.file(path).writer()` on construction
  - Serialize each event as one JSON line with ISO 8601 ts
  - Close method flushes and ends the writer
- [ ] **2.2** Handle error serialization: native Errors get `{ name, message, stack }`; everything else passes through JSON.stringify as-is (defineErrors objects serialize naturally because they're plain objects)
- [ ] **2.3** Tests: writes to a temp file, parses JSON lines, close flushes buffered writes

### Phase 3 — migrate library call sites

- [ ] **3.1** Materializer modules (markdown + sqlite): add `log?: Logger` option; default to `createLogger(<source>, consoleSink)` if not provided; replace `console.warn` / `console.error` calls with `log.warn` / `log.error`
- [ ] **3.2** Repeat for `attach-sync.ts`, `y-keyvalue-lww-encrypted.ts`, `on-local-update.ts`, `attach-timeline/sheet.ts`, etc. — anything currently using `console.warn` / `console.error` for diagnostic output
- [ ] **3.3** Update tests that asserted on console output, if any (likely few — most tests check return values, not console)

### Phase 4 — playground + documentation

- [ ] **4.1** Opensidian playground config: add a `jsonlFileSink` co-located with the markdown output directory
- [ ] **4.2** Update `.agents/skills/error-handling` (or create new `skills/logging`) with "consuming the logger" examples
- [ ] **4.3** Update `attach-primitive/SKILL.md` example to show the `log` option

## Edge Cases

### Bun writer stays open across process lifetime

1. `jsonlFileSink(path)` opens the writer on construction.
2. App runs, logger emits, writer buffers + periodically flushes.
3. On process exit: Bun closes file handles, but **pending buffered writes may be lost** without an explicit flush.
4. **Mitigation**: app-level `beforeExit` / `SIGINT` handler calls `sink.close()` which flushes and ends.

### Log file does not exist yet

1. `jsonlFileSink('/path/that/does-not-exist.jsonl')`.
2. `Bun.file(path).writer()` creates the file on first write.
3. No explicit `mkdir` — caller is responsible for parent directory.
4. **Recommendation**: document this; optionally provide a convenience that `mkdir -p`s the parent before opening.

### Multiple loggers writing to the same file

1. Two materializers both construct `jsonlFileSink('./app.log.jsonl')`.
2. Two independent file writers, both appending.
3. **Risk**: interleaved writes with torn lines.
4. **Mitigation**: caller shares ONE sink across loggers by creating it once:
   ```ts
   const sink = jsonlFileSink(path);
   const log1 = createLogger('markdown', sink);
   const log2 = createLogger('sqlite', sink);
   ```
   Documented idiom.

### Browser runtime

1. `jsonlFileSink` imports from `bun:sqlite` / `node:fs`-adjacent APIs — fails in browser.
2. `createLogger` + `consoleSink` + `memorySink` are pure JS, browser-safe.
3. **Resolution**: the JSONL sink lives in its own module behind its own import path; browser apps just don't import it.

### Error objects in `data`

1. Caller passes a native `Error` or a `defineErrors`-created object.
2. `JSON.stringify(event)` would produce `"error":{}` for native Errors because they don't have enumerable properties by default.
3. **Mitigation**: the JSONL sink runs a lightweight normalizer that extracts `.name`, `.message`, `.stack` from native Errors. defineErrors objects serialize directly because they're plain objects with enumerable fields.

### Test isolation

1. Tests that construct loggers should use `memorySink` to assert on emitted events.
2. `memorySink()` returns `{ sink, events: LogEvent[] }` so tests can inspect after emission.
3. Console / JSONL sinks should NOT be used in tests.

## Open Questions

1. **Default behavior when a logger is passed without a sink?**
   - Options: (a) throw, (b) use console, (c) silent no-op.
   - **Recommendation**: (b). Matches zero-config ergonomics.

2. **Does `log.error(message, errorObject)` duplicate `error.message` into the log's `message` field?**
   - Current design: yes, caller-provided message + error-provided message are both preserved.
   - **Recommendation**: keep both. Human-readable `message` is for humans; `data.message` (from the error) is for machines.

3. **Should sinks be async?**
   - Options: (a) sync only (current draft), (b) allow `Promise<void>` return.
   - **Recommendation**: (a). Logging should never block the call site; async sinks encourage footguns (unawaited promises). If a sink needs async, it buffers internally and drains periodically.

4. **Should `createLogger` accept multiple sinks as a fan-out?**
   - Options: (a) single sink argument, caller composes with `composeSinks(a, b, c)` helper, (b) array of sinks.
   - **Recommendation**: (a). Single sink keeps the type simple. `composeSinks(...)` helper for fan-out when needed.

5. **Do we migrate the 14 call sites in one commit or incrementally?**
   - **Recommendation**: Phase 3 is a single commit. Mechanical migration; all-or-nothing.

6. **Should `jsonlFileSink` auto-create the parent directory?**
   - Options: (a) require caller to `mkdir -p` first, (b) internally `mkdir -p` on first write.
   - **Recommendation**: (b). Single-line quality-of-life win; matches the "zero-config" feel.

## Success Criteria

- [ ] `createLogger('source', sink)` returns a `Logger` with `.debug`/`.info`/`.warn`/`.error` methods
- [ ] Default (`createLogger('source')`) uses `consoleSink` and matches current output shape
- [ ] `jsonlFileSink(path)` appends one JSON-per-line, closable via `.close()`
- [ ] `defineErrors` objects flow through to the sink with structure intact (verified via test with a known error)
- [ ] Native Error objects get `{ name, message, stack }` in JSONL output (not empty `{}`)
- [ ] All 14 library call sites migrated from `console.*` to `log.*`
- [ ] Opensidian playground adds a co-located JSONL sink and demonstrates tail-able output
- [ ] 600+ workspace tests continue to pass
- [ ] Memory sink enables test assertions: `expect(events).toContainEqual({ kind: 'warn', ... })`

## References

- `packages/workspace/src/document/materializer/markdown/materializer.ts` — current `console.warn` call sites, first migration target
- `packages/workspace/src/document/attach-sync.ts:659,858` — sync warnings that should be structured
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts:256` — decrypt failure (high-value: silent data loss today)
- `packages/workspace/src/document/materializer/sqlite/sqlite.ts:155` — sync failure
- `packages/workspace/src/document/materializer/sqlite/fts.ts:139` — FTS failure (currently returns empty, swallowing the error)
- `.claude/skills/error-handling/SKILL.md` — Result consumption patterns; logger should compose with these
- `.claude/skills/define-errors/SKILL.md` — typed error patterns; logger's `data` field flows these through
- Bun `FileSink` documentation: https://bun.sh/docs/api/file-io#writing-files-bun-write
- Pino's `transport` model for reference: https://getpino.io/#/docs/transports

## Suggested Execution Prompt

Copy into a fresh session to hand off:

> Execute `specs/20260422T222216-workspace-logger.md` on branch `braden-w/document-primitive` at `/Users/braden/conductor/workspaces/epicenter/copenhagen-v1`.
>
> Context: add a minimal structured logger to `@epicenter/workspace`. Default behavior matches current `console.*` output. Opt-in JSONL file sink via Bun's native `FileSink`. No global state, no library-owned paths — DI all the way.
>
> Phases:
> 1. Core logger module + console + memory sinks (~100 lines, one commit)
> 2. JSONL sink (~60 lines, one commit)
> 3. Migrate 14 library call sites (~80 lines of diff, one commit)
> 4. Playground integration + skill docs (~50 lines, one commit)
>
> Follow the spec's Design Decisions table exactly — unified `data` field, caller-decides-path, four levels, no global registry. Open questions have recommended answers in the spec; confirm them as you go.
>
> Run `bun test` after each phase. Known pre-existing failures in `create-table.test.ts`, `attach-encryption.test.ts`, etc. are from parallel refactors — ignore them, don't fix.
>
> Report per-phase: commit hash, tests passing, any design deviations from the spec.
