# Build-Time Platform DI via Filename Suffixes

**Status**: Proposed
**Type**: Build/architecture change (zero behavior change at runtime)
**Scope**: `apps/whispering/src/lib/services/*`, `vite.config.ts`

## Problem

Today, every cross-platform service uses runtime DI:

```ts
// services/clipboard/index.ts
export const ClipboardServiceLive = window.__TAURI_INTERNALS__
  ? createClipboardServiceDesktop()
  : createClipboardServiceWeb();
```

Both implementations are imported. The wrong one is bundled as dead code. The decision is evaluated at module load.

This conflates two unlike decisions:

1. **"What platform am I on?"** — a build-time fact. We know at `vite build` whether we're producing the Tauri bundle or the web bundle. There is no scenario where a single Tauri bundle would need to fall back to the web clipboard.
2. **"What user preference did the user pick?"** — a runtime fact. The transcription provider is OpenAI today, Groq tomorrow, with the same bundle.

Mixing them under one mechanism (the `__TAURI_INTERNALS__` ternary) has concrete costs:

- **Bundle bloat.** Web bundle ships Tauri code; Tauri bundle ships web fallbacks. Small per service; aggregate isn't free.
- **Weaker type safety.** Nothing prevents `web` impl from importing `@tauri-apps/api/*`. The bundler accepts it; we find out at runtime, or via a lint rule, or never.
- **Cognitive overhead.** Every reader meets the same ternary pattern and re-derives why.
- **No build-time enforcement.** A Tauri-only module (`tray`, `fs`, `globalShortcutManager`) accidentally imported from a web-facing path produces a runtime null reference, not a build error.

The fix is to separate the two decisions and give each the mechanism it deserves.

## Principle

- **Build-time facts** (the platform target) belong in build config. The bundler resolves them; the wrong impl never enters the bundle.
- **Runtime facts** (user preferences) belong in code. A switch statement reads settings.

The mechanism we recommend matches what VS Code, React Native, Metro, and similar large cross-platform codebases all use: **filename suffixes resolved by the bundler.**

## Mechanism: Vite `resolve.extensions` with `.tauri.ts` / `.web.ts`

Vite resolves bare module specifiers by trying file extensions in `resolve.extensions` order. By overriding that array per build target, the same import resolves to different files in each build.

### Convention

A module that needs platform variants has:

- `foo.ts` — default/web implementation (lives at the natural feature location)
- `foo.tauri.ts` — Tauri-specific override (sibling, same exports)

```
$lib/clipboard/
  service.ts         ← web impl + the shared interface (re-exported types)
  service.tauri.ts   ← Tauri impl, same exports
  rpc.ts             ← TanStack adapters, platform-agnostic
```

Consumers always write `import { ClipboardService } from '$lib/clipboard/service'`. They never name the platform.

### Vite config

```ts
// vite.config.ts
import { defineConfig } from 'vite';

const isTauri = process.env.TAURI_PLATFORM !== undefined;

export default defineConfig({
  resolve: {
    extensions: isTauri
      ? ['.tauri.ts', '.ts', '.tauri.js', '.js', '.json']
      : ['.web.ts', '.ts', '.web.js', '.js', '.json'],
  },
});
```

Build behavior:

- **Tauri build** sees `service.ts` AND `service.tauri.ts`. Vite tries `.tauri.ts` first, finds it, uses it. `service.ts` is never parsed.
- **Web build** sees the same files. Vite tries `.web.ts` first, doesn't find it, falls through to `.ts`. `service.tauri.ts` is never parsed.

### Tauri-only modules (no web fallback)

For services that don't exist on web (`tray`, `fs`, `cpal`, `autostart`, `globalShortcutManager`):

- `foo.tauri.ts` exists, `foo.ts` does **not** exist.
- Tauri build: resolves to `.tauri.ts`. Works.
- Web build: tries `.web.ts`, then `.ts`, neither exist. **Build error.**

This is the desired behavior. A web-bundled module accidentally importing a Tauri-only file fails at `vite build`, not at user runtime.

### Optional `.web.ts` explicit suffix

For services where the web impl is non-trivial and we want both files to make their target explicit:

- `foo.tauri.ts` + `foo.web.ts` (no `foo.ts`).
- Each build resolves to its target. Web build error if `.web.ts` missing; Tauri build error if `.tauri.ts` missing.

This is more explicit but requires both files. The recommendation: use plain `foo.ts` as the web default unless there's a reason to make the web target explicit.

### TypeScript handling

TypeScript needs to know which file to type-check against. Two patterns:

1. **Single tsconfig, both files present.** TypeScript sees both `service.ts` and `service.tauri.ts` and type-checks both. Each must satisfy the same export shape (enforced by a shared `types.ts` interface). Pro: simple. Con: TS may flag unused imports in `.tauri.ts` that look unused on the web build.

2. **Per-target tsconfigs with `moduleSuffixes`.** TypeScript 4.7+ supports `moduleSuffixes: ['.tauri', '']` to mirror the Vite resolution. Two `tsconfig.json` files extending a base. Pro: TS matches the actual build. Con: more config; needs CI to run both typechecks.

**Lean: pattern 1.** Both files visible to TS, both type-checked, shared interface in `types.ts`. The "unused import" noise is rare and easily ignored.

## Build-time DI vs runtime DI

A working rule. Apply the test to each existing branch and migrate accordingly.

### When build-time DI is right

The condition is decided when the bundle is produced. It cannot change for the lifetime of the bundle without a rebuild.

Examples in this codebase:

- **Clipboard** — Tauri uses native clipboard, web uses navigator clipboard. A Tauri build will never need the web impl.
- **Notifications** — Tauri uses native OS notifications, web uses browser notifications.
- **Recorder** — Tauri can use CPAL or navigator (currently a user setting, but the CPAL path itself only exists in Tauri).
- **Filesystem, tray, autostart, global shortcuts, command service** — Tauri-only.

**Pros of build-time DI:**

- **Smaller bundles.** Dead code never enters the artifact.
- **Stronger type safety.** Web bundle cannot accidentally import Tauri APIs (the file containing the import isn't in scope).
- **Build-time failure for misuse.** Importing a Tauri-only module from a web entry point fails `vite build`, not user runtime.
- **No `__TAURI_INTERNALS__` ternaries scattered through code.** Consumers are platform-blind.
- **Composable with feature folders.** The platform variant is local to the feature, not yanked into a separate folder.

**Cons of build-time DI:**

- **More files.** Two implementations per platform-bound service instead of one with branches.
- **Setup cost.** Vite config + (optional) tsconfig variants. One-time.
- **Less obvious from a file listing.** Reading `service.ts` alone doesn't tell you a `.tauri.ts` exists. Convention + grep mitigate this.
- **The "shared interface" discipline must hold.** Both files must export the same symbols with compatible types. A `types.ts` companion is the enforcement mechanism.

### When runtime DI is right

The condition is decided by the user or system at runtime and can change without rebuilding.

Examples in this codebase:

- **Transcription provider** — user picks OpenAI / Groq / Deepgram / Elevenlabs / Mistral / local in settings. Same bundle serves all choices.
- **Transformation provider** — similar.
- **Recording method** (CPAL vs navigator on Tauri) — user setting `recording.method` decides which to use at start time. Only meaningful on the Tauri bundle, but still a runtime decision within that bundle.

**Pros of runtime DI:**

- **One bundle serves many configurations.** No multi-target build.
- **User changes don't require a reinstall.**
- **Branch lives in code that's read alongside its logic** — natural location.

**Cons of runtime DI:**

- **All implementations are bundled.** A web build with five transcription providers ships all five.
- **No build-time misuse check.** A bug that calls the wrong provider passes typecheck and ships.
- **A runtime branch every call.** Negligible perf cost; non-negligible noise in the code if pervasive.

### The cleanest split

Apply both. Each call site uses the mechanism that matches the decision's nature:

```ts
// Build-time: Vite picks the right clipboard at bundle time
import { writeText } from '$lib/clipboard/service';

// Runtime: user setting picks the transcription provider at call time
const provider = settings.get('transcription.selectedTranscriptionService');
switch (provider) {
  case 'OpenAI':   return services.openai.transcribe(blob);
  case 'Groq':     return services.groq.transcribe(blob);
  case 'Deepgram': return services.deepgram.transcribe(blob);
  // ...
}
```

The platform check is invisible to the call site. The provider switch is visible because the choice is genuinely a runtime fact the reader should know about.

## What does NOT need to move

- **The transcription provider switch.** Stays runtime DI. Each provider has one impl that works on both platforms (HTTP).
- **Runtime feature flags.** Stays runtime DI.
- **Settings-driven behavior in general.** Stays runtime DI.
- **Services with only one impl across all platforms.** Don't need a `.tauri.ts` variant; they're just `.ts`.

## Migration plan

### Wave 1: Wire up the Vite config (one PR, no behavior change)

- [ ] Add `resolve.extensions` config keyed on `process.env.TAURI_PLATFORM` to `vite.config.ts`.
- [ ] Add a no-op `.tauri.ts` file somewhere to prove the resolution works (`tools/platform-check.ts` and `tools/platform-check.tauri.ts` that export different strings; assert in dev that the right one loaded).
- [ ] Delete the proof of concept after verification.

This is the smallest possible commit that introduces the mechanism. Reversible. No services touched yet.

### Wave 2: Migrate clipboard (first real service)

- [ ] Create `$lib/services/clipboard/web.ts` (was the `createClipboardServiceWeb` impl).
- [ ] Create `$lib/services/clipboard/tauri.ts` (was the `createClipboardServiceDesktop` impl).
- [ ] Rename current `index.ts` to a `types.ts` that exports the interface and re-export sites:
  - `service.ts` re-exports from `./web` (default)
  - `service.tauri.ts` re-exports from `./tauri`
- [ ] Consumers import `from '$lib/services/clipboard/service'` — no platform name.
- [ ] Remove the runtime ternary.
- [ ] Verify: web build doesn't include `@tauri-apps/api/clipboard-manager` (grep the bundle).

If wave 2 reveals problems (TypeScript can't resolve, types diverge silently, etc.), stop and fix the convention before doing more.

### Wave 3: Migrate notifications, recorder, tray, fs, autostart, command, globalShortcutManager

- [ ] One service per commit. Each commit independently revertable.
- [ ] Tauri-only services (`tray`, `fs`, etc.) get a `.tauri.ts` with no `.ts` sibling. Web build will fail if any web-bundled code imports them — that failure is the whole point.

### Wave 4: Clean up the runtime layer

- [ ] Grep for remaining `window.__TAURI_INTERNALS__` checks. Each should be a runtime decision (rare) or a leftover (delete it).
- [ ] Update services/README.md to describe the new pattern.
- [ ] Document the convention in ARCHITECTURE.md.

### Wave 5: Bundle audit

- [ ] Compare web bundle size before and after.
- [ ] Confirm `@tauri-apps/*` packages are absent from the web bundle (devtools network tab + grep).
- [ ] Confirm web-specific fallbacks (e.g., navigator MediaRecorder) absent from the Tauri bundle if it doesn't use them.

## Open decisions

1. **Default suffix-less file: web or Tauri?**
   The recommendation is **web is the default (`foo.ts`)** because web is the broader audience and most platform-agnostic services already work on web. Tauri is the override (`foo.tauri.ts`). This means Tauri builds are slightly slower to resolve (try `.tauri.ts` first, sometimes fall through to `.ts`). Negligible.

2. **Naming: `.tauri.ts` or `.desktop.ts`?**
   Tauri is the framework; desktop is the deployment target. They're synonyms today but a future iOS/Android Tauri build would still be "tauri" but not "desktop." **Lean: `.tauri.ts`.** Names what's actually true: the file uses Tauri APIs.

3. **Tsconfig setup: one or two?**
   Lean: one (see TypeScript Handling section). Revisit if "unused import" noise becomes an issue.

4. **Where does `$lib/services/desktop/` go?**
   Currently a folder for desktop-only services. With the suffix convention, each of these becomes `service.tauri.ts` with no `.ts` sibling. The `desktop/` folder dissolves. Or: keep `desktop/` as the home for Tauri-only services with no cross-platform counterpart, and use the suffix convention only for services with both. **Lean: dissolve `desktop/`** for consistency. One mechanism, one place to look.

5. **Composability with feature folders.**
   This works orthogonally. In the feature-folder spec, `$lib/recording/service/` becomes a folder with `index.ts` + `index.tauri.ts` siblings (or `navigator.ts` + `cpal.tauri.ts`). The Vite resolution is unchanged; the location of the files just moves with the feature. **No conflict between the two specs.**

## Risks

1. **Vite resolve.extensions edge cases.** If a third-party library uses `import './foo'` and we've configured `.tauri.ts` first, the library would accidentally pick up a `.tauri.ts` we've authored in its directory. Mitigated by the fact that `.tauri.ts` is our convention and won't appear in node_modules. Confirm during wave 1.

2. **Hot reload behavior.** Vite dev mode rebuilds on file change. If you add a `.tauri.ts` while the dev server is running, does it pick up? Confirm during wave 1.

3. **Two implementations drift.** Without a shared interface, `service.ts` and `service.tauri.ts` can diverge silently. **Mitigation:** require a `types.ts` next to them that both must satisfy. Type-check both files in CI.

4. **Bundle audit gives a false sense of security.** Tree-shaking is good; bundle inspection is the final word. Wave 5 (bundle audit) is non-optional.

5. **Migration of recorder is non-trivial** because the Tauri build itself has a runtime choice (CPAL vs navigator). After build-time DI, the Tauri bundle has both navigator AND CPAL recorders (the navigator one is shared with the web bundle). The runtime switch (`settings.get('recording.method')`) stays inside the Tauri build. **This is correct behavior** — recording method is a user setting, not a platform fact. But it's a non-obvious case where build-time and runtime DI compose, and worth documenting.

## Why this is a bigger unblock than feature folders

The feature-folder spec is about code locality. The platform-DI spec is about correctness, bundle size, and type safety. The platform-DI change has measurable benefits (smaller web bundle, build-time enforcement of platform boundaries) that the feature-folder change doesn't. Doing platform-DI first also means feature folders inherit a cleaner story for where platform-specific code lives (right next to the feature, with a `.tauri.ts` suffix).

**Recommended sequence:**

1. Platform-DI spec (this one) — gives every feature a clean platform-variant pattern.
2. Feature-folder spec — moves things around with the platform pattern already settled.

Doing them in this order means feature folders don't have to invent a platform story; they inherit one.

## First concrete move

Land **Wave 1 only** as a standalone PR. The Vite config change + proof-of-concept file pair. Zero impact on the rest of the codebase. Sets up the convention.

If wave 1 reveals a Vite gotcha, we learn cheaply. If it works, the rest of the migration is mechanical.
