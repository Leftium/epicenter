---
name: code-audit
description: Recurring smell categories in this codebase, with grep patterns to find them. Use when doing periodic code review, scoping a cleanup pass, or hunting for the kind of subtle smells that accumulate session-over-session — duck-typing leaks, untyped boundaries, ceremony tails, library logging discipline, union-churn signals.
metadata:
  author: epicenter
  version: '1.0'
---

# Code Audit Patterns

Recurring smell categories worth hunting periodically. Each category has a grep pattern, a real example from the repo (if one exists), and a "why it matters" so you know whether a hit is a real smell or expected.

> **Related skills**: See `refactoring` for the methodology of fixing what you find. See `one-sentence-test` for the cohesion audit that frames whether an abstraction earns its keep.

## When to Apply This Skill

Use when:

- Doing a periodic code-quality review pass.
- Scoping a cleanup PR.
- After a major refactor, hunting for stale boundaries the new design exposes.
- Reviewing a PR that touches a primitive — these patterns indicate where new contracts may be leaking into consumers.

The five categories below were validated against the actual codebase by repeated agent audits. They're not generic style nits — each one signals a specific kind of contract problem in a TypeScript-heavy framework codebase.

## 1. Duck-Typing at System Boundaries

**Pattern**: `(x as { foo?: unknown }).foo` or `as Record<string, unknown>` accesses where the shape isn't statically known.

```bash
grep -rn "as\s*{" packages/cli packages/workspace --include="*.ts" -B2 -A2
```

**Why it matters**: Each duck-type is a contract gap. The receiver doesn't know what it's getting; the producer doesn't know what's expected. Often justified at literal system boundaries (e.g., parsing user-provided configs, reading from third-party APIs), but unjustified inside the framework's own code.

**Example (justified)**: `packages/cli/src/util/handle-attachments.ts:41-45` — duck-types `sync` and `awareness` because the CLI bundles are user-defined and arbitrary. The 30-line comment block above the helper documents exactly why.

**Example (unjustified)**: `if (entry.handle.whenReady)` was duck-typing `whenReady` until it became a typed optional on `Document`. The diagnostic told us the contract was incomplete; the fix was to declare the field.

**How to triage a hit**: read the ~30 lines above the duck-type. If there's a comment explaining why static typing isn't possible at this boundary, leave it. If there's no explanation and the producer is an internal type, either widen the producer's type to include the field, or consolidate the access into a duck-typing helper that's itself well-documented.

## 2. `argv as Record<string, unknown>` Re-Assertions

**Pattern**: yargs argv re-asserted to a broad shape at every command handler.

```bash
grep -rn "argv\s*as\s*Record<string, unknown>" packages/cli --include="*.ts"
```

**Why it matters**: yargs types `argv` as loosely as it can. Every CLI command handler does `const args = argv as Record<string, unknown>` and then keys into it three or four times. Each access is a type-system escape — `argv.foo as string`, `argv.bar as number`. The type system isn't catching missing flags or typos at the source.

**Why it persists**: yargs's typed builder API is verbose and authors trade off ergonomics for safety. The trade is real, but worth periodically auditing — especially when adding a new flag, check whether the access pattern crosses the threshold where a typed argv extraction helper would pay off.

**Triage**: a single command with two flag accesses isn't worth a typed wrapper. Five flags or three commands sharing the same accessor pattern is. Look for **repeated** key access to the same field across command files; that's the signal to extract.

## 3. Promise-Shape Ceremony (`.then(() => {})`)

**Pattern**: explicit value-discarding tails on promise chains.

```bash
grep -rn "\.then\s*\(\s*(\(\)|=> \{\}|=> undefined)" packages --include="*.ts"
```

**Why it matters**: usually indicates the type at the receiving end is too narrow. Authors write `.then(() => {})` to convert `Promise<T>` into `Promise<void>` because the field accepting the promise is typed `Promise<void>` instead of `Promise<unknown>`. The ceremony adds zero semantic value.

**Recipe**: when you see this pattern, look at where the promise is being assigned. If the consumer awaits-and-discards (typical for readiness/teardown barriers), widen the field type to `Promise<unknown>`. The tail disappears.

**Example fix**: this codebase's `whenReady` / `whenLoaded` / `whenConnected` / `whenDisposed` fields were widened from `Promise<void>` to `Promise<unknown>` exactly to eliminate this ceremony. See spec `specs/20260424T000000-self-gating-attachments.md` for the rationale.

**False positive**: if the `.then(() => result)` returns a *meaningful* transformed value, leave it. The smell is specifically the "discard the value" form.

## 4. Unstructured Logging in Library Code

**Pattern**: `console.log` / `console.error` / `console.warn` outside of CLIs, tests, and benchmarks.

```bash
grep -rn "console\.(log|error|warn)" packages/workspace packages/sync --include="*.ts" | grep -v test
```

**Why it matters**: library code that calls `console` directly can't be redirected, silenced, or piped to a structured sink (jsonl file, in-memory test introspection). Every `console.log` is a hardcoded output decision the consumer can't override.

**The framework's logger**: `wellcrafted/logger` provides `createLogger(name)` plus pluggable sinks (`consoleSink`, `memorySink`, `composeSinks`, repo-owned `jsonlFileSink`). Three established injection patterns:

```ts
// Module-scoped (default)
const log = createLogger('module-name');

// Optional parameter (for libraries that may want a caller-supplied logger)
function createX({ log = createLogger('x') }: { log?: Logger } = {}) { ... }

// Config-injected (used in attachSync)
const log = config.log ?? createLogger('attachSync');
```

**Triage**: zero hits in `packages/workspace` and `packages/sync` as of this writing — the codebase is clean here. New `console.*` calls in library code should be refused at PR review.

## 5. Exhaustive `never` Checks as Union-Churn Signals

**Pattern**: `const _exhaustive: never = x` after a switch on a discriminated union.

```bash
grep -rn ": never\s*=" packages --include="*.ts" -B10
```

**Why it matters**: each `never` check is a contract promise — "if this union grows a variant, every consumer with this check will break." That's *good* — it's the type system catching missed cases. But if adding a single variant breaks five different switches, the variants are probably overlapping, the union is too broad, or the same logic is being implemented in too many places.

**Triage**: count call sites on the discriminated type. If 1-2 switches enforce exhaustiveness, fine. 5+ is a smell — consider:

- Moving the switch into a method on the union members themselves (each variant exports its own behavior).
- Splitting the union if some switches only care about a subset of variants.
- Extracting a single canonical handler that other consumers delegate to.

**False positive**: type-narrowing on a result type at a boundary is healthy, even if there are several. Look for the pattern of "every consumer has to know about every variant" as the actual signal.

## What This Skill Doesn't Catch (Reject from the Hunt)

Tested and rejected as not-actually-smells in this codebase:

- **Dead `kind:` branches** — exhaustiveness via `never` enforces this aggressively. No dead branches survive.
- **Dead exported types** — many exports across `packages/workspace`; spot-checks always hit consumers. Would need deeper dependency analysis to find real dead ones.
- **Stale file names** (`*-manager.ts`, `*-handler.ts`) — none found. Naming matches responsibility.
- **Async wrappers doing no work** — Yjs is sync-friendly; the codebase doesn't fake async.
- **Casual `@ts-expect-error` / `@ts-ignore`** — ~234 of them, but all justified (test doubles, duck-typing at system boundaries with comments).

If a future audit finds patterns consistent with these categories, they should be added here. If a category proves false (zero hits across multiple sweeps), demote it.

## Workflow

When kicking off a review pass:

1. Run all five greps against the relevant scope (single package, full monorepo, or recently-changed files).
2. For each hit, read the ±5 lines of context and decide: justified, refactor, or false-positive.
3. Group findings by category and impact before fixing — refactoring scattered hits one-at-a-time loses the pattern.
4. Document the fix in a single PR with the audit log. The pattern matters more than the individual instances.

The goal is **systematic detection**, not ad-hoc cleanup. These patterns repeat; codifying them here means future review passes don't re-derive them.
