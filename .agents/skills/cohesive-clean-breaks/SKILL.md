---
name: cohesive-clean-breaks
description: Use when making architecture decisions, API redesigns, breaking changes, migration plans, or cleanup plans where cohesion matters more than compatibility. Guides agents to preserve a clear product and code vision, reject hybrid compromise APIs, mentally inline abstractions, remove stale names, use dependency injection and inversion of control deliberately, move abstraction boundaries, and keep invariants owned by one layer.
---

# Cohesive Clean Breaks

Use this skill when a coding decision changes public shape, package boundaries,
runtime contracts, naming, config structure, lifecycle ownership, or migration
strategy.

The goal is not to minimize diff size. The goal is to make the final system
easy to explain, hard to misuse, and free of half-old, half-new behavior.

Related skills: use `one-sentence-test` to state the thesis, `refactoring` for
caller counting and straggler sweeps, `approachability-audit` for first-read
clarity, `change-proposal` when showing current and proposed trees before
editing, and `post-implementation-review` after implementation.

## One Sentence First

Start by writing the one sentence the new system must make true.

Good:

```txt
Config composes route definitions; app packages own their default route names.
```

Bad:

```txt
Support the new route format while preserving the old map for convenience.
```

If the sentence needs exceptions, aliases, or compatibility clauses to sound
true, the design is probably not clean yet.

## Ownership Test

For every important value and invariant, name the owner.

```txt
route name        app daemon package
route composition project config
socket ownership  daemon startup
runtime teardown  daemon runtime
peer lookup       peer directory
remote call       rpc attachment
```

If two layers own the same value, collapse the design before coding. Shared
ownership usually becomes drift.

If the same invariant is checked in several downstream files, move it to
construction time, validation, or the type signature. Repeated defensive checks
usually mean the boundary is too late.

## Scratch Redesign Pass

Before patching the current shape, ask what the API would look like if it were
designed today with no compatibility burden.

Write the ideal consumer call site first:

```ts
bindWorkspaceAuthLifecycle({
	auth,
	workspace,
	leavingUser: {
		afterCleanup: reload,
		onCleanupError: reportError,
	},
});
```

Then work backward into implementation. If the ideal call site needs the
consumer to pass unrelated things, the boundary is probably wrong. If it hides
important policy, the abstraction is too soft.

## Mental Inlining Pass

Before preserving a helper, layer, file, option, adapter, or component boundary,
mentally inline it into its caller.

Ask:

```txt
What does this layer actually add?
Would the caller be easier to understand if this code lived inline?
Is the name hiding simple control flow?
Is the abstraction preserving a stale boundary from an old design?
Does it exist because the current file tree made it convenient?
```

Keep the layer only when it owns a real invariant, names non-obvious domain
behavior, isolates unsafe input, or has enough callers to earn a stable
contract.

## Dependency Injection and Inversion of Control

Prefer injected dependencies over hidden imports when behavior crosses package
or runtime boundaries.

Good:

```ts
attachLifecycle({
	reportError,
	reload,
});
```

Bad:

```ts
import { toast } from '@app/ui';
import { workspace } from '@app/singleton';
```

Use inversion of control when the lower layer knows when something happened,
but the upper layer owns the policy for what to do next. For example, a
workspace lifecycle helper may know that signed-out cleanup finished; the app
decides whether to reload, show a toast, navigate, or keep running.

Do not use dependency injection as a dumping ground. Inject stable policies,
clients, sinks, and factories. Do not inject a bag of callbacks that mirrors
every internal step of an implementation.

Treat single-method `Pick<Thing, 'method'>` dependencies as a smell worth
checking. A single-method `Pick` often means the old object boundary leaked into
a place that only needed one verb. Prefer a named capability function in the
caller's language unless the caller genuinely participates in that object's
life cycle or needs the rest of the capability family. See
`docs/articles/single-method-pick-is-a-boundary-leak.md`.

## Boundary Movement

If a smell appears at several call sites, do not start by extracting a helper.
Ask which layer should own the invariant.

```txt
UI repeats cleanup            move cleanup to lifecycle binding
apps repeat sync registration move sync inventory to workspace
storage grows auth verbs      move auth shape to an adapter
core imports app concerns     move integration to the edge package
```

The best cleanup often moves a boundary instead of shortening a function.

## Consumer Ergonomics Test

Read the final API as a new caller.

Ask:

```txt
What is the one obvious call site?
Which options are domain policies, not implementation steps?
Can TypeScript prevent the common mistake?
Does the name explain the lifecycle moment?
Can the caller ignore details it does not own?
```

Ergonomics does not mean hiding failure. A clean API makes required policy
obvious and optional policy genuinely optional.

## API Shape Pressure

Prefer APIs with one obvious shape and one obvious lifecycle moment.

Smells:

```txt
boolean flags that choose unrelated modes
options named after implementation steps
parallel old and new properties
callbacks for every internal phase
types that expose storage details to UI callers
```

Fix by moving policy to the caller, moving invariants to the callee, or
splitting two products into two APIs. Do not make one surface accept every
historical shape.

## Reject Hybrid APIs

Do not keep both old and new shapes unless migration support is the explicit
product goal.

Prefer:

```ts
export default defineConfig({
	daemon: {
		routes: [defineFujiDaemon()],
	},
});
```

Avoid:

```ts
export default defineConfig({
	daemon: {
		routes: {
			fuji: defineFujiDaemon(),
		},
		alsoRoutes: [defineFujiDaemon()],
	},
});
```

Hybrid APIs feel helpful during implementation, but they make every caller ask
which path is canonical. That is a code smell.

## Breaking Change Rules

When making a clean break:

1. Delete old public names instead of aliasing them.
2. Rename call sites in one sweep.
3. Update docs and examples to show only the new shape.
4. Validate at the new boundary, not at every downstream use.
5. Make failure messages name the new contract.
6. Leave no fallback parser for the old shape unless migration compatibility is
   the explicit product goal.
7. Move invariants to construction time or type signatures when possible.
8. Prefer lifecycle-shaped names over implementation-shaped names.

Compatibility is a feature. If nobody explicitly asked for that feature, do not
smuggle it into the implementation.

## Naming Rules

Names should describe lifecycle and ownership.

```txt
define*     returns inert definitions
connect*    talks to an existing process or service
open*       creates or opens local resources
start*      performs side effects and begins runtime work
load*       reads and validates without starting resources
```

If a helper returns a delayed route definition, name it `defineFooDaemon()`, not
`fooDaemon()` or `openFooDaemon()`.

## Config Shape Rules

Default export should match the file name and the validated boundary.

```txt
epicenter.config.ts -> export default defineConfig(...)
```

Named exports are fine for local organization, but the default export is the
validated boundary.

```ts
export const fuji = defineFujiDaemon();

export default defineConfig({
	daemon: {
		routes: [fuji],
	},
});
```

Do not make the CLI scan arbitrary named exports. It hides the contract and
makes startup side effects harder to reason about.

Do not introduce a second config file shape just because it looks cleaner in
isolation. A new config filename is a product decision, not a local refactor.

## File Organization Check

When the design changes ownership, sketch the current and proposed trees before
editing.

```txt
Current
packages/foo/
|-- lifecycle.ts
|-- lifecycle-options.ts
|-- cleanup.ts
`-- index.ts

Proposed
packages/foo/
`-- lifecycle.ts
```

Flatten stale directories when they only preserve an old concept. Rename files
when their owner changed. Keep a file split only when each file has a distinct
reason to exist for a new reader.

## Final Check

Before finishing, grep for old vocabulary, old shapes, old filenames, removed
exports, fallback parsers, stale comments, and examples. If old names still
appear outside historical specs or migration notes, the break is incomplete.

Ask:

```txt
Can I explain the new API without saying "or"?
Does one layer own each invariant?
Would a new caller find only one obvious path?
Are examples free of compatibility shapes?
Are side effects injected as policy instead of imported as hidden globals?
Did I move the boundary that caused the smell, or only wrap it?
Did I delete stale names instead of leaving aliases?
Did I delete dead paths instead of leaving them unreachable?
Did the file tree change to match the new ownership?
Did every validation move to the earliest layer that can know the truth?
Would mentally inlining each new helper make the code clearer?
```

If any answer is no, keep simplifying.
