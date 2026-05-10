# UI Native Package Imports

**Date**: 2026-05-10
**Status**: Implemented
**Author**: AI-assisted

## One-sentence thesis

```txt
packages/ui should use native package-private imports for its own source graph,
while apps continue to consume only the @epicenter/ui public package API.
```

## Overview

This changes `packages/ui` from generated relative-import cleanup to named
native package imports: `#ui`, `#utils`, `#hooks`, and `#lib`. The app side does
not get a SvelteKit alias, Vite alias, or app tsconfig path for UI source.

## Motivation

### Current State

Apps already consume UI through public package exports:

```ts
import { Button } from '@epicenter/ui/button';
import { cn } from '@epicenter/ui/utils';
import '@epicenter/ui/app.css';
```

The earlier cleanup removed app aliases and converted UI internals to relative
imports:

```ts
import { Button } from '../button/index.js';
import { cn } from '../utils.js';
```

That worked, but it made every generated shadcn-svelte or
shadcn-svelte-extras update noisier than it needed to be. The generator wants
aliases. We then had to review generator output and convert the imports by
hand.

This creates problems:

1. **Generated diffs are larger than the real change.** Import rewrites obscure
   the component update.
2. **The generator and source conventions disagree.** `components.json` needs
   aliases, while committed source was expected to avoid them.
3. **The naked `#` spelling is suspicious.** `#/*` feels like an alias, not a
   package import. The local probe confirmed that `#/utils` did not resolve in
   `packages/ui` svelte-check.
4. **App configs must stay uninvolved.** The right fix cannot require this in a
   consuming app:

```js
kit: {
	alias: {
		'#': '../../packages/ui/src',
	},
}
```

### Desired State

UI source uses named package-private imports:

```ts
import { Button } from '#ui/button';
import { cn } from '#utils';
import { useCombobox } from '#hooks';
import CopyButton from '#lib/copy-button/copy-button.svelte';
```

`packages/ui/package.json` owns those names:

```json
{
	"imports": {
		"#hooks": "./src/hooks/index.ts",
		"#hooks/*.svelte": "./src/hooks/*.svelte.ts",
		"#hooks/*.svelte.js": "./src/hooks/*.svelte.ts",
		"#hooks/*": "./src/hooks/*",
		"#lib/*.js": "./src/*.ts",
		"#lib/*": "./src/*",
		"#ui/*": "./src/*/index.ts",
		"#utils": "./src/utils.ts",
		"#utils/*": "./src/utils/*.ts"
	}
}
```

`components.json` points shadcn-svelte at the same names:

```json
{
	"aliases": {
		"components": "#ui",
		"utils": "#utils",
		"ui": "#ui",
		"hooks": "#hooks",
		"lib": "#lib"
	}
}
```

`tsconfig.shadcn.json` exists only to keep the generator happy. The real
`tsconfig.json` does not need those paths because TypeScript resolves package
imports through `package.json`.

## Research Findings

### Native package imports

Node package imports are private package mappings whose keys start with `#`.
TypeScript resolves them from the nearest `package.json` when package imports
are enabled under modern module resolution. This repo uses bundler resolution in
the shared base config, so `#utils` and `#ui/button` are valid source imports
inside `packages/ui`.

Sources:

- https://nodejs.org/api/packages.html#imports
- https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-imports-and-self-name-imports

### `#utils` versus `#/utils`

The important local finding is that named imports work and slash-after-hash
imports do not.

```txt
Probe: packages/ui source imported from #/utils
Result: packages/ui svelte-check reported Cannot find module '#/utils'

Probe: packages/ui source imported from #utils
Result: packages/ui svelte-check resolved the import

Probe: apps/honeycrisp consumed @epicenter/ui while packages/ui used #utils
Result: app typecheck did not need a kit.alias or app tsconfig path
```

This is the reason to avoid `#/*`. It is not just a taste objection. It failed
the source-resolution check that matters for this package.

### shadcn-svelte

shadcn-svelte uses `components.json` aliases and validates them through the
TypeScript config named in `typescript.config`. It does not require those paths
to live in the package's normal `tsconfig.json`.

Implication: keep `tsconfig.shadcn.json`. It is a generator adapter, not a
runtime or app resolver.

### shadcn-svelte-extras and jsrepo

`packages/ui/jsrepo.config.ts` paths are filesystem install targets for
`@ieedan/shadcn-svelte-extras`. They are not import aliases. They can stay
simple:

```ts
paths: {
	ui: './src',
	lib: './src',
	util: './src/utils',
	hook: './src/hooks',
	hooks: './src/hooks',
}
```

The installed files then use the package-private import names from
`package.json#imports`.

### SvelteKit and Vite config

SvelteKit `kit.alias` belongs to apps. Adding `'#':
'../../packages/ui/src'` to every app would make UI internals leak into
consumers again. The app should only see `@epicenter/ui`, so app config stays
unchanged.

Source: https://svelte.dev/docs/kit/configuration#alias

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Internal UI imports | 1 evidence | Use named package imports such as `#utils` and `#ui/button` | Local svelte-check resolved named imports and rejected `#/utils`. |
| Slash-after-hash imports | 1 evidence | Do not use `#/*` or `#/utils` | They behave like alias paths and failed the package source probe. |
| App config | 2 coherence | Do not add `kit.alias`, Vite aliases, or app tsconfig paths for UI | Consumers should depend on package exports, not source layout. |
| Public UI imports | 2 coherence | Apps keep using `@epicenter/ui/...` | This preserves the package boundary and matches `exports`. |
| `tsconfig.shadcn.json` | 2 coherence | Keep it separate from `tsconfig.json` | It exists for shadcn-svelte alias validation. Merging it would turn generator compatibility into general source config. |
| `components.json` aliases | 2 coherence | Point them at `#ui`, `#utils`, `#hooks`, and `#lib` | The generator now emits imports that match committed source. |
| `#lib/*` | 3 taste under constraint | Use it only for direct internal file imports | Some extras import concrete component files or helper types. `#lib/*` names that escape hatch without exposing it to apps. |
| `jsrepo.config.ts` | 1 evidence | Keep filesystem paths | jsrepo installs files by path; those entries are not resolver aliases. |

## Architecture

```txt
shadcn-svelte CLI
  reads packages/ui/components.json
  reads packages/ui/tsconfig.shadcn.json
  writes packages/ui/src/*

packages/ui source
  imports #ui/button
  imports #utils
  imports #hooks
  imports #lib/copy-button/copy-button.svelte
  resolves through packages/ui/package.json#imports

apps/*
  import @epicenter/ui/button
  import @epicenter/ui/utils
  resolve through packages/ui/package.json#exports
```

There are two resolver surfaces:

```txt
Private to packages/ui:
  #ui, #utils, #hooks, #lib

Public to apps:
  @epicenter/ui/*
```

No app owns UI private names.

## Why `tsconfig.shadcn.json` should stay separate

I would keep it separate.

`tsconfig.json` is the source contract for `packages/ui`. Its job is to typecheck
the package. It should not carry generator-only compatibility paths when the
language already has a native resolver for the imports we use.

`tsconfig.shadcn.json` has a narrower job: make shadcn-svelte's alias validator
understand the aliases in `components.json`. That is useful enough to keep, but
not broad enough to merge.

Merging would create this ambiguity:

```txt
Is #ui resolved by TypeScript paths, package.json#imports, or both?
```

Keeping it separate gives us this cleaner split:

```txt
Real source:
  package.json#imports

Generator compatibility:
  components.json + tsconfig.shadcn.json

Apps:
  package.json#exports
```

That is also why we do not need per-app package files, per-app tsconfig aliases,
or `kit.alias` entries.

## Implementation Plan

### Phase 1: Establish native package imports

- [x] Add named `imports` mappings to `packages/ui/package.json`.
- [x] Change `packages/ui/components.json` aliases to `#ui`, `#utils`,
      `#hooks`, and `#lib`.
- [x] Keep shadcn alias paths in `packages/ui/tsconfig.shadcn.json`.
- [x] Keep `packages/ui/tsconfig.json` free of those paths.

### Phase 2: Convert UI source

- [x] Convert cross-component UI imports from relative paths to `#ui/*`.
- [x] Convert utility imports to `#utils` and `#utils/*`.
- [x] Convert hook imports to `#hooks` and `#hooks/*`.
- [x] Use `#lib/*` only for direct file imports that are not public barrels.

### Phase 3: Protect the boundary

- [x] Update the UI boundary check so app configs cannot reintroduce private UI
      import paths.
- [x] Update the UI boundary check so app source cannot import private UI import
      names.
- [x] Keep the check forbidding naked `#`, `#/...`, and `@epicenter/ui/...`
      self-imports inside UI source.
- [x] Update package docs to explain the new resolver split.

### Phase 4: Verify

- [x] Run the UI boundary check.
- [x] Run an app typecheck to prove consumers do not need app aliases.
- [x] Run a UI typecheck and confirm there are no `Cannot find module '#...'`
      resolver failures.

## Verification

Commands:

```bash
bun run check:ui-boundary
(cd packages/ui && bun -e "await import('#utils'); await import('#utils/casing'); await import('#hooks')")
(cd packages/ui && bun -e "console.log(import.meta.resolve('#ui/button')); console.log(import.meta.resolve('#lib/copy-button/types.js')); console.log(import.meta.resolve('#hooks/use-auto-scroll.svelte.js'))")
(cd apps/honeycrisp && bun run typecheck)
(cd packages/ui && bun run typecheck)
(cd packages/ui && bun run typecheck 2>&1 | rg "Cannot find module '#|Module '\"#|Could not resolve '#")
```

Observed result:

- Boundary check passes.
- Bun resolves `#utils`, `#utils/casing`, and `#hooks` from inside
  `packages/ui`.
- Bun resolves `#ui/button`, `#lib/copy-button/types.js`, and
  `#hooks/use-auto-scroll.svelte.js` to the expected files.
- `apps/honeycrisp` typecheck passes with 0 errors and no app alias.
- `packages/ui` still reports pre-existing component typing issues, currently
  73 errors in 11 files, but the targeted resolver scan reports no missing
  modules for `#ui`, `#utils`, `#hooks`, or `#lib`.

## Non-goals

- Do not expose `#ui`, `#utils`, `#hooks`, or `#lib` to apps.
- Do not add `kit.alias` for UI source in any app.
- Do not merge `tsconfig.shadcn.json` into `tsconfig.json`.
- Do not make `#lib/*` a public import style for consumers.
