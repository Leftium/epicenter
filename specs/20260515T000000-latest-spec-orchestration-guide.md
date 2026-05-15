# Latest Spec Orchestration Guide

**Date**: 2026-05-15
**Status**: Draft
**Author**: Braden + Codex

## One Sentence

Finish the live auth and daemon unblockers first, then run isolated product lanes in parallel, keeping each branch reviewable by dependency rather than by theme.

## What This Guide Is For

The latest specs are not one linear project. They are a small portfolio:

1. A broken or incomplete runtime plane that should be fixed first.
2. A daemon and scripting architecture cleanup that becomes easier once auth is stable.
3. Product expansion work that should not sit on top of daemon churn unless it truly needs to.

This guide orders the six active specs by dependency, importance, and implementation risk.

## The Six Work Items

| # | Work item | Source spec | Difficulty | Importance | Recommended lane |
| --- | --- | --- | --- | --- | --- |
| 1 | OOB CLI Phases 3-4 | `20260514T210000-execute-oob-cli-phases-3-4.md` | 4/5 | 5/5 | Auth unblocker |
| 2 | Machine Auth OOB cleanup | `20260514T120000-machine-auth-oob-clean-break.md` | 4/5 | 5/5 | Auth unblocker |
| 3 | Single daemon, many workspaces | `20260514T170000-single-daemon-multi-workspace.md` | 3/5 for Phase 1, 4/5 overall | 4/5 | Daemon cleanup |
| 4 | Script surfaces resolution | `20260514T160000-script-surfaces-resolution.md` | 3/5 | 4/5 | Scripting cleanup |
| 5 | Source app manifest bridge | `20260514T013918-source-app-manifest-bridge-slice.md` | 2/5 | 3/5 | Source app foundation |
| 6 | Self-host first-class | `20260514T220000-self-host-first-class.md` | 5/5 | 4/5 | Deployment expansion |

Difficulty means expected implementation and review complexity. Importance means how much it unblocks the current system or future architecture.

## Recommended Order

### 1. Ship OOB CLI Phases 3-4

Do this first.

This is the current bottleneck. The execution spec says the CLI auth surface and daemon plane are still stubbed or broken. Until this lands, daemon smoke tests are weak, and anything that depends on `createMachineAuthClient()` is built on uncertain ground.

Target branch:

```txt
codex/oob-cli-phases-3-4
```

Suggested commit stack:

```txt
1. feat(auth): add OOB OAuth launcher
2. feat(auth): implement machine auth client
3. feat(cli): wire auth commands to OOB login
4. test(auth): cover machine auth and CLI status flows
```

Exit criteria:

```bash
bun --cwd packages/auth test
bun --cwd packages/auth typecheck
bun --cwd packages/cli test
bun --cwd packages/cli typecheck
```

Manual smoke:

```txt
epicenter auth login
epicenter auth status
one daemon route boots and can reach /api/me
```

### 2. Split Single Daemon Phase 1 Into Its Own PR

Do not start with the whole single daemon spec. Extract the highest value piece: shared auth injection.

The real bug is that multiple daemon routes can create separate machine auth clients and race on the same session storage. Fixing that is smaller than the full root config and naming pass, and it helps every later daemon or scripting change.

Target branch:

```txt
codex/daemon-shared-auth
```

Suggested commit stack:

```txt
1. refactor(workspace): inject auth into daemon route start
2. refactor(apps): consume injected auth in daemon routes
3. test(cli): cover multiple daemon routes sharing auth
```

Exit criteria:

```bash
rg "createMachineAuthClient" apps/*/blocks/daemon-route.ts
# expect zero matches

bun run typecheck
bun test packages/workspace packages/cli
```

Decision point after this PR:

```txt
If daemon route startup feels clean, continue to root config and naming.
If it exposes more auth lifecycle problems, stop and patch those before renaming anything.
```

### 3. Land Script Surfaces Cleanup

Once daemon auth is stable, clean up scripts.

Scripts should stop pretending to be alternate daemon processes. The target shape is simple: read from SQLite, write through `connectDaemonActions`.

Target branch:

```txt
codex/script-surfaces-sqlite-actions
```

Suggested commit stack:

```txt
1. feat(workspace): add read-only workspace SQLite helper
2. chore(fuji): remove snapshot and script blocks
3. docs: document script reads via SQLite and writes via daemon actions
4. chore(specs): mark superseded script references
```

Exit criteria:

```bash
rg "openFujiScript|openFujiSnapshot|openHoneycrispScript|openOpensidianScript|openZhongwenScript" --glob '!specs/**'
# expect zero matches

bunx jsrepo build
bun run typecheck
```

Keep this PR out of the full single daemon naming pass. It should be a behavioral cleanup, not a rename festival.

### 4. Finish Single Daemon Root Config And Naming

Do this after shared auth and script cleanup.

At this point the route abstraction should be clearer. Rename `define*Daemon` to `define*Route`, add the root config story, and document the one-process mental model.

Target branch:

```txt
codex/single-daemon-root-config
```

Suggested commit stack:

```txt
1. feat(cli): support root daemon config with multiple routes
2. refactor(apps): rename define app daemon helpers to route helpers
3. docs(cli): explain one daemon hosting many workspace routes
```

Exit criteria:

```bash
test -f epicenter.config.ts
rg "defineFujiDaemon|defineHoneycrispDaemon|defineOpensidianDaemon|defineZhongwenDaemon"
# expect zero matches outside historical specs

bun test packages/workspace packages/cli
bun run typecheck
```

### 5. Build Source App Manifest Bridge In Parallel

This one can run independently once someone has bandwidth.

It creates a small `@epicenter/app` package and does not need the daemon work. Keep it isolated. Do not let it pull in a loader, Tauri shell changes, app installation, permissions UI, or workspace RPC changes.

Target branch:

```txt
codex/source-app-manifest-bridge
```

Suggested commit stack:

```txt
1. feat(app): add source app manifest parser
2. feat(app): add typed Epicenter bridge
3. test(app): cover manifest and bridge contracts
```

Exit criteria:

```bash
bun test packages/app
bun --cwd packages/app typecheck
```

This is a good parallel task because conflicts should be low.

### 6. Start Self-Host Only After OOB CLI Is Real

Self-host is strategically important but should not start on top of an unfinished auth story.

Start it after OOB CLI lands. It can run in parallel with later daemon naming work, but the first self-host PR should be pure adapter scaffolding with no Bun runtime behavior yet.

Target branch stack:

```txt
codex/self-host-runtime-adapters
  └── codex/self-host-bun-adapters
        └── codex/self-host-setup-docs
```

Suggested PR stack:

```txt
PR 1: runtime adapter boundary, Cloudflare behavior unchanged
PR 2: Bun runtime adapters and entrypoint, room registry stub allowed
PR 3: setup script, .env.example, self-host docs, CLI base URL support
```

Exit criteria for PR 1:

```bash
bun run typecheck
bun test apps/api
wrangler dev smoke still reaches /sign-in, /api/me, and /rooms/:room
```

Exit criteria for PR 2:

```bash
bun --cwd apps/api start
curl http://localhost:8787/api/health
sign-up and /api/me work against local Postgres
asset upload writes to local filesystem
```

Exit criteria for PR 3:

```bash
bun install
cp apps/api/.env.example apps/api/.env
bun --cwd apps/api setup
bun --cwd apps/api start
EPICENTER_API_URL=http://localhost:8787 epicenter auth login
```

## Dependency Map

```txt
OOB CLI Phases 3-4
    │
    ├── daemon shared auth
    │       │
    │       ├── script surfaces cleanup
    │       │
    │       └── single daemon root config and naming
    │
    └── self-host CLI base URL and OOB flow

source app manifest bridge
    │
    └── independent for now
```

## Stack Shape

Do not make one six-branch stack. Use three lanes.

```txt
Lane A: auth and daemon correctness

main
  └── codex/oob-cli-phases-3-4
        └── codex/daemon-shared-auth
              └── codex/single-daemon-root-config
```

```txt
Lane B: scripting cleanup

main or daemon-shared-auth
  └── codex/script-surfaces-sqlite-actions
```

```txt
Lane C: product expansion

main
  ├── codex/source-app-manifest-bridge
  └── codex/self-host-runtime-adapters
        └── codex/self-host-bun-adapters
              └── codex/self-host-setup-docs
```

## How To Think About The Work

Use this rule:

```txt
If the work fixes a broken current path, do it before architecture cleanup.
If the work changes names or mental models, do it after behavior is stable.
If the work creates a new product surface, keep it off the runtime cleanup stack.
```

That gives this priority order:

```txt
1. Make CLI auth and daemon boot real.
2. Remove auth races in daemon routes.
3. Remove dead or misleading script surfaces.
4. Normalize daemon shape and naming.
5. Add source app contracts.
6. Make self-host a real deployment target.
```

## Risk Notes

### OOB CLI

Risk is high because it touches OAuth, persisted auth, CLI behavior, and daemon boot. Keep tests tight and do manual smoke before stacking more daemon work on it.

### Shared Auth Injection

Risk is medium. The type signature break is intentional. Keep it small so failures point at route startup, not at unrelated renames.

### Script Surfaces

Risk is medium. The risk is accidental deletion of a useful dev path. Mitigate by proving there are no non-spec callers and by documenting the replacement.

### Single Daemon Naming

Risk is medium-high. Renames create broad diffs. Do them only after the route startup behavior is already settled.

### Source App Bridge

Risk is low-medium. The main risk is scope creep. The package should be contract only.

### Self-Host

Risk is high. It cuts across runtime, storage, auth, static assets, and CLI configuration. Keep the first PR behavior-preserving for Cloudflare.

## Coordination Rules

1. Only stack branches when the child truly needs the parent.
2. Prefer one reviewable behavior change per PR.
3. Put broad renames after behavior changes, not before.
4. Keep self-host PR 1 behavior-preserving.
5. Keep source app work isolated until a later loader spec exists.
6. Before starting each branch, reread the source spec and append an implementation note when the branch lands.

## Immediate Next Move

Start with:

```txt
codex/oob-cli-phases-3-4
```

Do not begin self-host, single daemon naming, or script deletion until the OOB CLI branch can prove:

```txt
epicenter auth login works
epicenter auth status works
at least one daemon route boots using the machine auth client
```

That is the foundation. Everything else gets easier once that is true.
