# Collapse Tauri-only services into a single namespace

**Status:** Proposed
**Scope:** apps/whispering
**Author:** working session
**Related:** `docs/articles/20260525T234034-two-files-one-import-build-time-platform-injection.md`, `apps/whispering/specs/20260526T010258-build-time-platform-di.md`

## TL;DR

Move all Tauri-only capabilities (`fs`, `command`, `permissions`, `ffmpeg`, `tray`, `globalShortcuts`, `autostart`) out of `apps/whispering/src/lib/services/<cap>/` and into a single file `apps/whispering/src/lib/tauri.tauri.ts`. Replace the per-capability `index.browser.ts` throwing stubs with one file: `tauri.browser.ts`, which is one line (`export default null;`). Consumers use `import tauri from '$lib/tauri'` and access capabilities through optional chaining (`tauri?.fs.pathToBlob(path)`). The `services/` folder shrinks to only genuinely dual-implementation services (`clipboard`, `text`, `http`, `notifications`, `os`, `sound`, `download`, `analytics`, `blob-store`, `recorder`).

## The problem

The current Tauri-only services pretend to be dual-implementation services. Each lives in `services/<cap>/index.tauri.ts` and most have a sibling `services/<cap>/index.browser.ts` whose only job is to satisfy Vite's web build resolver and throw at runtime if called. The throw is unreachable in practice because consumers gate calls behind `window.__TAURI_INTERNALS__`.

Concrete shape today:

```
services/
├── _tauri-stub.ts                              shared `unreachable` throw
├── fs/
│   ├── index.tauri.ts                          real Rust-backed impl
│   └── index.browser.ts                        throwing stub
├── command/         (same)
├── permissions/     (same)
├── ffmpeg/
│   ├── index.tauri.ts
│   ├── index.browser.ts
│   └── shared.ts                               platform-neutral constants
├── global-shortcut-manager/  (same)
├── autostart/
│   └── index.tauri.ts                          no browser stub (no web-reachable consumer)
├── tray/
│   └── index.tauri.ts                          no browser stub (same reason)
└── clipboard/, text/, http/, ...               genuinely dual-impl
```

Three things are wrong with this:

**The pattern lies.** `fs` has no web implementation, never has, never will. Calling it a "service" with a "web variant" puts it in the same shape category as `clipboard`, which does have both. That shape category is a fiction for the Tauri-only entries.

**The stub files exist to satisfy Vite, not the program.** Five files in `services/*/index.browser.ts` exist solely because some web-bundled file imports the path. They throw if called, but they're never called. They're build-time scaffolding masquerading as runtime code.

**The asymmetry between `autostart`/`tray` and the others isn't principled.** `autostart` and `tray` lack browser stubs because nothing web-bundled reaches them directly. That distinction is invisible from the folder layout. A new contributor looking at the tree can't tell which services need stubs and which don't.

The same asymmetric refusal applies: refuse to model "Tauri-only capability" as a special case of "dual-impl service." Pull it out into its own namespace, give it its own consumer pattern, and let the symmetry between dual-impl services (which all have two real implementations) actually mean something.

## The proposal

### One file replaces the seven

```
apps/whispering/src/lib/
├── tauri.tauri.ts        all Tauri capabilities, ~250 lines
├── tauri.browser.ts      `export default null;`
└── services/             only dual-impl services live here
```

### The Tauri file

`tauri.tauri.ts` is one file with capability sections. Each section defines an error type and a capability object. The file ends with one composition line and one cast:

```ts
// $lib/tauri.tauri.ts
import { invoke } from '@tauri-apps/api/core';
import { readFile } from '@tauri-apps/plugin-fs';
import { Command } from '@tauri-apps/plugin-shell';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { TrayIcon } from '@tauri-apps/api/tray';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { defineErrors } from 'wellcrafted/error';
import { tryAsync, Ok } from 'wellcrafted/result';

// fs ----------------------------------------------------------------
export const FsError = defineErrors({
  ReadBlobFailed: ['cause'],
  ReadFileFailed: ['cause'],
  ReadFilesFailed: ['cause'],
});

const fs = {
  pathToBlob: (path: string) => tryAsync({ /* ... */ }),
  pathToFile: (path: string) => tryAsync({ /* ... */ }),
  pathsToFiles: (paths: string[]) => tryAsync({ /* ... */ }),
};

// command -----------------------------------------------------------
export const CommandError = defineErrors({
  ExecuteFailed: ['cause'],
  SpawnFailed: ['cause'],
});

const command = {
  execute: (cmd: ShellCommand) => tryAsync({ /* ... */ }),
  spawn: (cmd: ShellCommand) => tryAsync({ /* ... */ }),
};

// permissions, ffmpeg, tray, globalShortcuts, autostart follow the same shape

const tauri = { fs, command, permissions, ffmpeg, tray, globalShortcuts, autostart };
export default tauri as typeof tauri | null;
```

The trailing `as typeof tauri | null` is the only piece of compile-time ceremony. It forces consumers to narrow before access, which gives us the runtime gate for free.

### The browser file

```ts
// $lib/tauri.browser.ts
export default null;
```

One line. No imports. No type annotations. Vite's `resolve.extensions` picks this on web builds, the Tauri file on Tauri builds. The whole `tauri/*` import graph never enters the web bundle because nothing reaches it.

### Consumer pattern

Every consumer looks the same:

```ts
import tauri from '$lib/tauri';

// Imperative gate
if (tauri) {
  await tauri.fs.pathToBlob(path);
  await tauri.tray.setIcon('IDLE');
}

// Or optional chain
await tauri?.fs.pathToBlob(path);
```

The optional chain is the platform gate. No `window.__TAURI_INTERNALS__` at call sites. No `await import()` for module loading. The variable name (`tauri`) tells the reader what's gated. The type system forces the narrow.

## Type story

`apps/whispering/tsconfig.json` already has:

```json
"moduleSuffixes": [".tauri", ".browser", ""]
```

TypeScript resolves `import tauri from '$lib/tauri'` to `tauri.tauri.ts` for type-checking, so consumers see `typeof tauri | null` as the type. On web at runtime the import resolves to `tauri.browser.ts` which exports `null`. The type and runtime agree: in both worlds the value is "namespace or null."

This is why we don't need to `export type Tauri` or have the browser file import any type. The `.tauri.ts` file is the single source of type truth. The `.browser.ts` file is the single source of runtime truth on web. Vite + `moduleSuffixes` keeps them in sync without any explicit shared type declaration.

## What gets deleted

| Path | Reason |
|---|---|
| `services/_tauri-stub.ts` | `unreachable` no longer used; no stubs to throw |
| `services/fs/index.tauri.ts` | inlined into `tauri.tauri.ts` |
| `services/fs/index.browser.ts` | no longer needed (`$lib/tauri` resolves to `tauri.browser.ts`) |
| `services/fs/` (folder) | empty after the two deletes above |
| `services/command/*` | same pattern as fs |
| `services/permissions/*` | same |
| `services/ffmpeg/index.{tauri,browser}.ts` | same; `ffmpeg/shared.ts` moves to `lib/constants/ffmpeg.ts` (platform-neutral) |
| `services/global-shortcut-manager/*` | same |
| `services/autostart/index.tauri.ts` | same |
| `services/tray/index.tauri.ts` | same |
| `rpc/desktop/index.browser.ts` | rpc/desktop barrel rewires through `$lib/tauri`; no separate stub needed |
| Stub pattern paragraphs in `services/README.md` | obsolete |
| Stub explanation in `ARCHITECTURE.md` | obsolete |

Total: ~13 source files, ~50 lines of README/ARCHITECTURE prose.

## What stays in `services/`

The genuinely dual-implementation services. These each have a real browser implementation and a real Tauri implementation that compose against a shared interface:

```
services/
├── clipboard/    {index.tauri.ts, index.browser.ts, types.ts}
├── text/         same
├── http/         same
├── notifications/ same
├── os/           same
├── sound/        same
├── download/     same
├── analytics/    same
├── blob-store/   index.{tauri,browser}.ts + file-system.tauri.ts + web.ts + types.ts
├── recorder/     navigator.ts (shared) + cpal.tauri.ts + index.{tauri,browser}.ts + device-stream.ts + types.ts
├── transcription/ runtime-DI; provider chosen by settings
├── transformations/ runtime-DI; provider chosen by settings
└── completion/   runtime-DI; provider chosen by settings
```

Three patterns coexist in `services/` after the migration, and the folder layout tells you which is which:

1. **Suffix DI (clipboard, text, http, notifications, os, sound, download, analytics, blob-store, recorder)**: dual-impl, Vite picks the file at build time.
2. **Runtime DI (transcription, transformations, completion)**: one set of files, branches at call time on `settings.value`.
3. **Tauri-only**: not in `services/` anymore. Lives in `lib/tauri.ts`.

## Migration plan

Six waves. Each is independently revertable.

### Wave 1: scaffold the new namespace

Create `apps/whispering/src/lib/tauri.tauri.ts` with one capability ported (`ffmpeg`, picking up where the existing probe at commit `6708a1d93` left off). Create `apps/whispering/src/lib/tauri.browser.ts` with `export default null;`. Don't touch any consumers yet. Verify both builds pass.

### Wave 2: migrate `transcribe.ts` to the namespace

Rewrite `apps/whispering/src/lib/operations/transcribe.ts` from the current `await import('$lib/tauri/ffmpeg')` pattern (from the probe) to `import tauri from '$lib/tauri'; if (tauri) { /* ... */ }`. Delete the old `lib/tauri/ffmpeg.ts` from the probe. This validates the consumer pattern with one capability.

### Wave 3: port the remaining six capabilities into `tauri.tauri.ts`

Move `fs`, `command`, `permissions`, `tray`, `globalShortcuts`, `autostart` from their `services/<cap>/index.tauri.ts` files into sections of `tauri.tauri.ts`. Keep `ffmpeg/shared.ts` at `lib/constants/ffmpeg.ts` (it's platform-neutral; web consumers need it too).

Delete the old `services/<cap>/` folders for these seven capabilities (`fs`, `command`, `permissions`, `ffmpeg`, `tray`, `globalShortcuts`, `autostart`).

Delete `services/_tauri-stub.ts`.

### Wave 4: migrate web-bundled consumers

For each file that statically imports a former Tauri-only service, rewrite to use `import tauri from '$lib/tauri'`:

- `routes/(app)/+page.svelte` (fs for file-drop)
- `register-permissions.ts` (permissions)
- `macos-enable-accessibility/+page.{svelte,ts}` (command + permissions)
- `install-ffmpeg/+page.svelte` (command + fs)
- `GlobalKeyboardShortcutRecorder.svelte` (global-shortcut-manager)

### Wave 5: migrate Tauri-only consumers (`rpc/desktop/*.tauri.ts`)

These files only run on Tauri builds, so they can statically import from `$lib/tauri`. The narrowing is unnecessary but harmless. Pattern:

```ts
// rpc/desktop/fs.tauri.ts (hypothetical)
import tauri from '$lib/tauri';
const fs = tauri!.fs;  // safe: this file only loads on Tauri builds
```

Or, more honestly, name the import differently to express the assumption:

```ts
import tauri from '$lib/tauri';
// This file is only bundled on Tauri builds; tauri is non-null.
const { fs } = tauri!;
```

Delete `rpc/desktop/index.browser.ts` once the rpc adapters are all migrated.

### Wave 6: docs and cleanup

Update `apps/whispering/src/lib/services/README.md` to describe two patterns (suffix DI for dual-impl, runtime DI for user-pick) and link to this spec for the third (Tauri-only namespace, lives elsewhere). Update `ARCHITECTURE.md` to remove the Tauri-only stub explanation.

Add a short header comment to `tauri.tauri.ts` that links back to this spec so future readers can find the rationale.

## Why a single file instead of `lib/tauri/<cap>.ts` + barrel

A folder with per-capability files plus a `tauri.tauri.ts` barrel that re-imports them would work, but:

- The barrel becomes 7 lines of `import * as fs from './tauri/fs'` plus one composition line. Pure plumbing.
- "Adding a new Tauri capability" becomes two file edits (new file + barrel update) instead of one (new section in `tauri.tauri.ts`).
- The cohesion across the seven files is total: they all change when Tauri APIs change, they all bundle together, they share imports. Splitting them across files communicates independence they don't have.

The trigger to split would be either size (file passes ~500 lines) or genuine independent evolution (one capability gets a complex helper that doesn't belong with the others). Neither is true today. The single-file shape says "this is the Tauri bridge," which is the right level of abstraction.

## Why not `export type Tauri`?

The browser file doesn't need it. TypeScript's `moduleSuffixes` resolves consumer imports to `.tauri.ts` for type-checking, so the Tauri file's `as typeof tauri | null` annotation is the only place the union type appears. The browser file's `export default null` doesn't need any type information because TypeScript never looks at it for type resolution.

The earlier sketch with `export type { Tauri }` was a habit from situations where the browser file needs to honestly annotate `null as Tauri | null`. Here, that's strictly unnecessary. Less ceremony wins.

## Runtime DI vs build-time DI vs namespace

Three patterns coexist after this migration:

| Pattern | File layout | Consumer pattern | Used for |
|---|---|---|---|
| **Build-time platform DI** | `services/<cap>/{index.tauri.ts, index.browser.ts}` | Plain static import | Genuinely dual-impl: clipboard, text, http, etc. |
| **Runtime DI** | `services/<cap>/<provider>.ts` + a switch | Switch reads `settings.value` at call time | User-selectable providers: transcription, transformations, completion |
| **Tauri namespace** | `lib/tauri.tauri.ts` + 1-line browser stub | `import tauri from '$lib/tauri'; tauri?.<cap>.method()` | Tauri-only capabilities |

The test for which pattern fits:

1. Does the answer change between web and desktop, but not between users? → build-time platform DI.
2. Does the answer change at runtime based on user settings? → runtime DI.
3. Is this only available on one platform with no fallback? → namespace.

## Risks

**1. The cast `as typeof tauri | null` is a stated lie.** On Tauri builds, `tauri` is never `null` at runtime, but the type forces narrowing. Some readers may find this annoying ("why am I optional-chaining when I'm only running on Tauri?"). The alternative (no `| null`) means web at runtime crashes when consumers forget to gate. The forced narrow trades a small ergonomic cost for build-time correctness. Documented in the spec; should be documented at the top of `tauri.tauri.ts`.

**2. Tauri-only code that imports from `$lib/tauri`** (like the new `rpc/desktop/*.tauri.ts` after Wave 5) has to do a non-null assertion or narrow. Documented above.

**3. File size growth.** `tauri.tauri.ts` will be ~250 lines after the migration. If it grows past ~500 lines, the split-into-folder decision deserves a re-evaluation. The split is trivial to do later (each section becomes a file, the bottom of `tauri.tauri.ts` becomes a barrel). Not a one-way door.

**4. The `_tauri-stub.ts` + `unreachable` helper is deleted, but it might be useful elsewhere.** Specifically, the `unreachable: (...args: unknown[]) => never` trick could be useful for runtime-DI fallbacks. If we find a use case, re-add it at `lib/unreachable.ts`. Don't preserve it under the old name in `services/` purely for future-proofing.

## Open questions

1. **Should `ffmpeg/shared.ts` move to `lib/constants/ffmpeg.ts` or stay near the Tauri namespace?** It's used by both web (settings UI for compression options) and the Tauri ffmpeg impl. Putting it at `lib/constants/ffmpeg.ts` matches how other neutral constants are organized. Lean: move it.

2. **Naming: `globalShortcuts` vs `globalShortcutManager`?** The current folder is `services/global-shortcut-manager/`. Inside the namespace, the manager noun is redundant (everything in `tauri` is a manager of something). Lean: rename to `globalShortcuts` for brevity.

3. **Naming: `tauri?.fs.pathToBlob` vs `tauri?.fs.FsServiceLive.pathToBlob`?** The current Tauri-only services wrap their methods in a `XxxServiceLive` object (matching the dual-impl pattern). In the namespace, the extra wrapping is noise. Lean: drop the `XxxServiceLive` indirection; the namespace key (`fs`, `command`, ...) does the job that wrapping used to do.

## Estimated cost

Half a working day for the full migration. Each wave is small (~30 minutes to ~2 hours), reviewable in isolation, and revertable without touching adjacent waves. The ffmpeg probe already validated the consumer pattern, so there's no exploratory phase left.

## What this enables next

Once the namespace exists and the consumer pattern is established, two follow-ups become cleaner:

- **Tauri version checks.** If we ever need to gate on Tauri version (e.g., a capability only available in Tauri 2.5+), the namespace is the natural place to add a `version` field or feature flags.
- **Mock Tauri for tests.** A test harness can `vi.mock('$lib/tauri', () => ({ default: mockNamespace }))` once. Today, mocking would require mocking each `services/<cap>/index.tauri.ts` individually.

Neither is part of this spec. Both are cheaper after the migration than before it.
