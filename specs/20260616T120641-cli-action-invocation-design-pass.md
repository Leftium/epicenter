# CLI / action invocation design pass

- **Status:** Draft
- **Date:** 2026-06-16

How a human P2 user and a coding agent invoke Epicenter actions with structured
input. This pass pressure-tested the input-grammar question and traced it to
ground truth in the code; the conclusion is that the input grammar was never the
real decision. The real decision is which surface each consumer uses, and that
falls out of one invariant the code already enforces.

## TL;DR

- There is exactly one write engine: `daemon.run` over the Unix socket. Every
  other surface (CLI, script, in-app AI, future MCP) is an ergonomic skin over
  it. The input is always one JSON value validated against the action's schema.
- **The wire boundary is the action boundary.** Tables and KV are in-process
  only; anything crossing a process boundary (peer, script, CLI, AI) sees
  actions and nothing else. This is structural, not policy.
- **Coding agents default to scripts** (`bun ./script.ts` + `connectDaemonActions`),
  because a typed object literal is the best input modality in the system and
  the harness reviews the whole short program once. The CLI is the human path
  and the agent's granular-per-call-approval escape hatch.
- **No CLI sugar.** No `--arg key=value`, no generated `--flags`, no nested key
  grammar. The CLI keeps one JSON lane with three sources (inline / `@file` /
  stdin), exactly as it already does.
- **Query actions are the default read path** for scripts; the direct-file
  SQLite reader is the bulk / FTS / analytical escape hatch.

## Ground truth (verified against code, not docs)

The grilling repeatedly turned up that the docs lag the code. These are the
load-bearing facts, with file references:

1. **The action input schema is JSON Schema.** `input?: TInput` is a TypeBox
   `TSchema` (`packages/workspace/src/shared/actions.ts:64,89`), which is a plain
   JSON Schema object at runtime (`tool-bridge.ts:160`). It is validated at the
   trust boundary via `Value.Check` (`actions.ts:421`).

2. **One key addresses five consumers.** The snake_case action key is "the local
   address, peer RPC method, daemon argument, CLI flag, and AI tool name"
   (`actions.ts:139`). The system is deliberately one shape.

3. **`tool-bridge.ts` already makes actions LLM-native.** It maps the manifest to
   `{ name, inputSchema, execute }` tools and stamps `needsApproval` on mutations
   (`ai/tool-bridge.ts:137-166`). The in-app chat path is JSON-Schema-driven and
   shipped.

4. **The CLI already implements one JSON lane, three sources.** Inline JSON,
   `@file.json` (curl convention), or stdin all resolve to one JSON value
   (`cli/src/util/parse-input.ts:16-36`). `epicenter list <action>` already prints
   the input fields and `--format json` emits the raw schema (`cli/src/commands/list.ts:96,163-167`).

5. **A script holds no workspace and no Y.Doc.** `connectDaemonActions` returns a
   `Proxy` whose `get` trap turns any property name into
   `client.run({ actionPath: prop, input })` (`client/daemon-actions.ts:62-72`).
   There is no `.tables`, `.kv`, or `.ydoc` to reach. `TActions` is type-only:
   "no workspace code runs in the caller process" (`client/connect-daemon-actions.ts:8`).

6. **The browser developer has full table access.** `connect()` returns
   `ConnectedWorkspace = ConnectedWorkspaceContext & { idb, collaboration, wipe }`
   (`document/workspace.ts:239-247`), and the context carries the full connected
   `tables` and `kv` (`workspace.ts:224-230`). The `compose` callback returns only
   `actions` because `compose` defines the wire surface served to peers
   (`workspace.ts:255-257`), not because it gates the local developer. Tables/KV
   never cross the wire, so there is nothing about them to "return."

7. **The daemon is built on top of the mount.** A `Mount` is `create()` (workspace
   root: tables + kv + actions) plus `attachMountInfrastructure` (log, relay,
   materializers) around the same `ydoc` (`daemon/attach-mount-infrastructure.ts:1-31`).
   The daemon hosts one mount per root, holds full in-process table access as the
   single writer, and serves actions over the wire.

## The invariant that decides everything

**Access scope is a function of writer-identity, expressed as: the wire boundary
is the action boundary.** An action is the published, schema-guarded,
serializable projection of in-process table/KV access. It does not replace table
access; it is a layer over it (an action handler gets `.tables`/`.kv` but no
`.open`, `workspace.ts:112-126`).

| Who | Owns a doc? | Surface | How they get it |
| --- | --- | --- | --- |
| Daemon | yes (single writer) | full `tables` + `kv` + `actions` | `defineWorkspace.create()` + mount infra |
| Browser | yes (local, syncs) | full + storage/transport | `defineWorkspace.connect()` |
| Script / agent | no | actions only + read-only SQLite | `connectDaemonActions` + `openWorkspaceSqlite` |
| In-app AI | no | actions only | `actionsToAiTools` |
| Peer (mesh) | no | actions only | `run --peer` / dispatch |

"Scripts may only dispatch actions" is not a guard anyone wrote. It falls out of
the proxy having no other surface. This is the powerful, reusable vertebra: it
already governs the daemon, the browser, scripts, AI, and the mesh with one rule.

## Recommendations

### Canonical machine/agent path

There is no single canonical path because there is no single consumer. There is a
single engine (`daemon.run`) and a skin per consumer:

- **Coding agent (default): a script.** `bun ./script.ts` reading SQLite and
  writing through `connectDaemonActions<TActions>`. The typed object literal
  (`fuji.entries_update({ id, tags: ['triaged'] })`) is compile-time checked
  against the app's action registry: strictly better input ergonomics than a
  runtime-validated JSON string, and it is what coding agents are best at
  producing. This is ADR 0009's "automation lives in library scripts," now also
  recognized as the agent's best input modality, not a fallback.
- **Human / agent granular escape hatch: the CLI.** `epicenter run <action>
  <json | @file | stdin>`. One-shot, one call, per-call approval at the issuing
  harness, one shell-history audit line. Right when the unit of work is a single
  action (the finance example is four independent one-shot calls).
- **In-app chat: `tool-bridge.ts`.** Already shipped. No change.
- **External agents (later, not now): an MCP server generated from the action
  manifest.** Reuses the manifest-to-JSON-Schema mapping `tool-bridge.ts` already
  proves. MCP's win over the CLI is interface (no shell quoting, structured args,
  built-in discovery), not performance: both bottom out in the same `daemon.run`.

### Unit-of-work rule (the agent's decision procedure)

- **Single action** (independent, one-shot) -> discrete `epicenter run` call.
  Free per-call approval, granular audit. Quoting is the only tax and is a
  non-issue for cursor payloads like `{"since":"2026-01-01"}`.
- **Program** (loop, branch, compose, read-then-write) -> a typed script.
  Composition, compile-time-checked input, one warm process. Approval is
  whole-program: the harness reads the short script once before running it.

Per-action approval has gravity: it lives where the calls are issued (the
harness), not in the headless daemon, which has no prompt channel and validates
schema, not policy. A bespoke "is this script safe" classifier is a fragile thing
to build to recover granularity you get for free by keeping risky work as
discrete CLI calls.

### Sugar verdict: none

No `--arg key=value`, no generated `--flags`, no nested `--arg a.b=c` grammar.
Reasons:

- The schema is JSON Schema. Every sugar is a lossy re-encoding that must handle
  string-vs-number-vs-bool coercion, nesting, and arrays, driven by the live
  schema. `--arg count=5`: string `"5"` or number `5`? gh's `--field` answers
  this by auto-coercing, which is exactly the type-ambiguity mess to avoid in a
  typed system.
- Generated typed flags (option 3) require the CLI to fetch the schema from the
  daemon before parsing argv, a round-trip per invocation, and the flag surface
  drifts as schemas change. yargs builds its option spec statically.
- It fractures the deliberate one-shape design (`actions.ts:139`) into N+1 ways to
  do the same thing.
- The JSON-native consumers (scripts, AI, MCP) never touch a shell, so sugar
  serves only hand-typing humans, whose real need is discoverability, not a second
  grammar.

Discoverability is served by `epicenter list <action>` (already prints fields)
plus, optionally, a `--template` / scaffold that emits a pre-filled JSON skeleton
to stdout or `$EDITOR`. That closes the "I don't know the shape" gap without a
parallel input grammar.

### Read path: query actions by default

- **Default read path for a script: query actions** (typed via `TActions`,
  strongly consistent with in-memory state, same proxy as writes). The agent's
  entire vocabulary becomes "call actions," read and write, which rhymes with the
  CLI rule (the action is the default unit) and fixes the typed-writes /
  untyped-reads asymmetry.
- **Escape hatch: the direct-file SQLite reader** (`openWorkspaceSqlite`,
  read-only, `O(rows)`, FTS5) for bulk / analytical / join-heavy reads where one
  SQL scan beats N RPC calls.

**Rejected: an arbitrary-SQL action (`sql_query({ sql })`).** It defeats the only
reason the SQLite reader exists: the reader is fast because it hits the file
directly in the script process with no IPC and no result-set serialization. An
action would serialize the full result set back over the socket, making the
bulk-read path slower, while still returning untyped rows (no typing gain) and
opening a broad arbitrary-SQL surface. The one place it could earn its keep is a
remote peer reading another node's materialized data it cannot open as a file: a
separate, later, strictly-read-only mesh capability, not the local-script default.

### Habit guidance: actions are the wire/invariant boundary, not a universal wrapper

In-process code (browser components, the daemon, action handlers) should use raw
`.tables`/`.kv` for local edits where the operation is the user's intent and no
one off-process needs it; wrapping a one-line `set` in an action buys nothing.
Promote to an action exactly when: something off-process must perform it
(peer/CLI/AI/script call only actions), it bundles an invariant that must hold
identically everywhere, or it needs schema validation at a trust boundary. Litmus:
"does anything but this local code need to do this?" Yes -> action. No -> raw
table.

## Command grammar (CLI, unchanged)

```sh
# no input
epicenter run finance_materialize_markdown -C ~/Finance

# scalar / object input (inline JSON, the common case)
epicenter run finance_sync_brex '{"since":"2026-01-01"}' -C ~/Finance

# nested object: @file is clearer than any key-path grammar
epicenter run finance_import @statement.json -C ~/Finance

# array input
epicenter run accounts_tag '{"ids":["cash","brex"],"tag":"liquid"}' -C ~/Finance

# generated / piped payload: stdin
jq -n '{since: $d}' --arg d 2026-01-01 | epicenter run finance_sync_brex -C ~/Finance

# discoverability
epicenter list -C ~/Finance
epicenter list finance_sync_brex -C ~/Finance              # prints input fields
epicenter list finance_sync_brex --format json -C ~/Finance # raw JSON Schema
```

Agent program (the default for anything beyond a single action):

```ts
import { connectDaemonActions, findEpicenterRoot, openWorkspaceSqlite } from '@epicenter/workspace/node';
import type { FinanceActions } from '@epicenter/finance';

const root = findEpicenterRoot();
const fin = await connectDaemonActions<FinanceActions>({ epicenterRoot: root });

// default read path: typed query action
const { data: pending } = await fin.transactions_pending();

// bulk/analytical read: direct-file escape hatch
const db = openWorkspaceSqlite(root, 'epicenter-finance');
const byMonth = db.query('SELECT month, SUM(amount) FROM txns GROUP BY month').all();
db.close();

// writes: typed object literal, compile-time checked
await fin.finance_sync_brex({ since: '2026-01-01' });
```

## Follow-up actions

- DONE: harvested the wire-boundary invariant into
  [ADR-0010](../docs/adr/0010-actions-are-the-only-surface-that-crosses-a-process-boundary.md)
  (Accepted), with the no-sugar / scripts-default / no-SQL-action consequences
  recorded there.
- DONE: reframed `docs/scripting.md` to lead with query actions as the default
  read path and demote the SQLite reader to the bulk/FTS escape hatch.
- OPEN: no code change to the CLI is required (the existing JSON-three-sources
  surface is already correct). This spec is now spent; per the ADR hygiene rule it
  should be deleted once Braden has read ADR-0010, with the red-team below
  preserved in git history.
- OPTIONAL: `epicenter run <action> --template` (or `epicenter schema <action>`)
  emitting a pre-filled JSON skeleton, as the discoverability answer in place of
  sugar. Additive, reversible; build only if hand-typing humans ask for it.
- DEFERRED: MCP server from the action manifest. Not now; revisit when an external
  agent surface is actually needed. The manifest-to-tool mapping is already proven
  by `tool-bridge.ts`.

## Red team (why this might be wrong)

- **`gh` ships both `--field` sugar and `--input` JSON, and is wildly successful,
  so "no sugar" may be dogmatic.** Counter: `gh`'s domain is untyped REST where
  `--field` is the only typed-ish affordance; Epicenter has a per-action schema, so
  the discoverability that `--field` smuggles in is better served by
  `list <action>` without the coercion ambiguity. If user testing shows humans
  genuinely hate quoting small objects, a *typed* generated-flags mode (option 3)
  scoped to top-level scalar fields is the least-bad sugar, and it is purely
  additive later.
- **Whole-program approval may be too coarse.** A script that reads benignly then
  issues one destructive write gets one yes/no. Mitigation today: keep destructive
  one-offs as discrete CLI calls; mutations already carry `needsApproval` in the
  AI path, and the same metadata could gate a future per-action prompt if a prompt
  channel is ever added. If this bites, it argues for discrete CLI calls as the
  agent default, flipping the unit-of-work rule.
- **"Query actions as default read path" adds RPC latency to every read.** For
  read-heavy agents this could dominate. Mitigation: the SQLite escape hatch is
  exactly one import away, and the rule is a default, not a wall. If most real
  scripts turn out to be analytical, SQLite-first is the better default and this
  flips.
- **No MCP now may strand external agents.** If Cursor/Claude-Desktop users want
  Epicenter actions tomorrow, the CLI-via-shell story is worse than MCP. Counter:
  the manifest-to-tool mapping is already built; standing up an stdio MCP server is
  small when the need is real, and shipping it speculatively is maintenance with no
  consumer.
- **The whole pass largely affirms the status quo.** The risk is that grilling
  rationalized existing code rather than improving it. Honest assessment: the
  net-new decisions are real (no sugar as an explicit refusal, query-actions-first
  reads as a doc reversal, the wire-boundary invariant named and reused, scripts
  promoted from fallback to agent default), but the CLI surface itself genuinely
  did not need to change, which is the correct outcome when the code already
  encodes the right invariant.
```
