# UI Package Guide

This guide explains the UI package import boundary, the shadcn-svelte style
system it uses, and the component update workflow.

## Component Library Overview

This package is a vendored fork of **shadcn-svelte** (1.x) on the **Vega**
preset, plus a few **shadcn-svelte-extras** and Epicenter-specific components.

It uses shadcn-svelte's `cn-*` style system: component markup carries semantic
hook classes (`cn-button-variant-default`, `cn-dialog-content`) and the actual
styling lives in CSS:

- `src/styles/style-vega.css` (vendored): the Vega preset. All `cn-*` rules,
  scoped under `.style-vega`.
- `src/styles/shadcn-base.css` (vendored): the upstream base (data-* custom
  variants, `no-scrollbar`, accordion keyframes) the `cn-*` rules depend on.
- `src/styles/epicenter-overlay.css`: Epicenter style deltas (custom variants
  and per-component overrides). The single place our styling diverges from Vega.

Apps activate the preset with `class="style-vega"` on their root element; the
`cn-*` rules are scoped under it, so without the class nothing is styled. The
preset is a one-class swap (e.g. to `style-rhea`). Background and rationale:
`specs/20260606T160000-ui-shadcn-cn-style-migration-vega.md`.

### Dialog vs Modal Usage Guidelines

We use different component types based on the interaction pattern:

**Use Dialog + AlertDialog for:**

- Confirmations and simple yes/no prompts
- Display-only content (viewing information)
- Simple action confirmations (delete, cancel, etc.)
- Non-interactive content presentation

**Use Modal for:**

- Forms with user input (text fields, dropdowns, etc.)
- Complex interactions requiring typing
- Multi-step workflows with form data
- Any component where users need to input data

**Decision Rule:** If the user needs to type or input data, use Modal. Otherwise, use Dialog/AlertDialog.

**Examples:**

- `ConfirmationDialog` (just yes/no buttons)
- `CreateWorkspaceModal` (multiple form inputs)
- `EditRecordingModal` (text inputs and editing)
- `DeleteWorkspaceButton` (uses AlertDialog for confirmation)

## Key Differences from Standard shadcn-svelte

### 1. Import Boundary

Apps import UI through the public package API:

```typescript
import { Button } from '@epicenter/ui/button';
import { cn } from '@epicenter/ui/utils';
import '@epicenter/ui/app.css';
```

Files inside `packages/ui/src` import other UI files with relative paths:

```typescript
import { Button } from '../button/index.js';
import { cn } from '../utils.js';
```

Direct raw file imports use the same rule:

```typescript
import Button from '../button/button.svelte';
```

Do not add app aliases or tsconfig paths that point to `packages/ui/src`.
Do not add `kit.alias` entries such as:

```js
kit: {
	alias: {
		'#': '../../packages/ui/src',
	},
}
```

The UI package has no private import aliases. Apps should never define aliases
for `packages/ui/src`.

### 2. Package Imports and Exports Structure

Our `package.json` exposes only the public API for app consumers:

```json
{
	"exports": {
		"./*": "./src/*/index.ts",
		"./utils": "./src/utils.ts",
		"./utils/*": "./src/utils/*.ts",
		"./app.css": "./src/app.css"
	}
}
```

Consumers import components through the package API; UI source imports siblings
with relative paths.

### 3. Styling: the overlay, not inline overrides

Component styling lives in `cn-*` classes, not inline Tailwind. Keep component
markup byte-identical to upstream Vega so it stays trivially re-vendorable, and
put every Epicenter style delta in `src/styles/epicenter-overlay.css`.

**Custom variants** (no upstream equivalent) become a `cn-*` class. Example, the
button `ghost-destructive` variant:

```css
/* epicenter-overlay.css, under .style-vega */
.cn-button-variant-ghost-destructive {
	@apply text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20;
}
```

```svelte
// button.svelte tv()
'ghost-destructive': 'cn-button-variant-ghost-destructive',
```

**Per-component overrides** redefine the Vega `cn-*` class. The overlay is
imported after `style-vega.css` (same `layer(base)`), so a same-specificity rule
here wins:

```css
.cn-select-content { @apply max-w-min; }
```

**Invariant:** every `cn-*` class a component emits must be defined in
`style-vega.css` or `epicenter-overlay.css`. An undefined `cn-*` class is a dead
no-op; do not emit one.

Two kinds of delta stay inline, by necessity:

- **Utilities-layer overrides** of a property Vega sets inline in the component
  (notably z-index). A base-layer `@apply` cannot beat a utilities-layer inline
  utility, so override inline, or use `@apply ...!` in the overlay.
- **Structural divergences** (extra wrapper elements, `<svelte:element>`, an
  injected actions overlay) are markup, not CSS, and live in the component.

## Component Management Workflow

Components are (mostly) byte-identical to upstream shadcn-svelte Vega markup, so
updates are a careful copy plus a translation step.

### Updating or adding a component

1. Copy the component's `cn-*` Vega markup from upstream shadcn-svelte (or
   generate it in a scratch project pinned to a 1.x version).
2. Normalize imports to relative paths (`../utils.js`, `../button/index.js`).
   The committed package has no generator aliases.
3. Strip `IconPlaceholder`; use direct `@lucide/svelte/icons/*` imports.
4. Move every Epicenter style delta into `epicenter-overlay.css` (see Styling
   above). Do not leave inline override args stacked on a `cn-*` class.
5. Confirm the invariant: every `cn-*` class the component emits is defined.
6. Run `bun run check:ui-boundary` and build a consuming app.

### Re-vendoring the whole preset

To pull a newer Vega, replace `src/styles/style-vega.css` (and `shadcn-base.css`
if the base changed) with the upstream file, then re-check the invariant. Newly
defined `cn-*` classes may let you drop overlay overrides; newly emitted hooks in
components may need definitions.

### Do NOT

- Regenerate with the shadcn-svelte CLI and copy blindly. It pulls
  `IconPlaceholder` and generator aliases, and reintroduces the inline form.
- Stack inline Tailwind overrides on top of a `cn-*` class. Use the overlay.

### Import Path Convention

```typescript
// App code
import { Button } from '@epicenter/ui/button';

// UI package source
import { Button } from '../button/index.js';
import { cn } from '../utils.js';
```

## Directory Structure

```
packages/ui/
├── src/
│   ├── button/
│   │   ├── button.svelte
│   │   └── index.ts
│   ├── styles/
│   │   ├── shadcn-base.css        # vendored upstream base
│   │   ├── style-vega.css         # vendored Vega preset (all cn-* rules)
│   │   └── epicenter-overlay.css  # Epicenter deltas (variants + overrides)
│   ├── utils.ts
│   └── app.css                    # imports the three style files
├── package.json
└── tsconfig.json
```

## Best Practices

1. **Keep Components Pure**: no business logic in UI components.
2. **Use Barrel Exports**: each component folder has an `index.ts`.
3. **Style in the overlay**: Epicenter deltas go in `epicenter-overlay.css`, not
   inline on the component, unless they must stay inline (see Styling).
4. **Hold the invariant**: never emit a `cn-*` class that is not defined.
5. **Consistent Imports**: relative inside `packages/ui/src`; `@epicenter/ui`
   only from consumers outside this package.

## Boundary Check

Run the boundary check after changing UI imports or app config:

```bash
bun run check:ui-boundary
```

The executable source of truth is `scripts/check-ui-boundary.ts`.
The check fails when app configs point at `packages/ui/src`, when app configs
or package manifests add private UI import paths, when app source imports
private UI import names, when app or package source imports `packages/ui/src`
directly, or when UI source imports itself through private aliases or
`@epicenter/ui/...`.

## Troubleshooting

### Import Resolution Issues

If imports are not resolving:

1. Check that the component is exported by `@epicenter/ui`.
2. Ensure your IDE recognizes the package's TypeScript config.
3. Restart the TypeScript language server.

### Style Conflicts

If a custom style is not applying:

1. Confirm the rule is in `epicenter-overlay.css` (imported after
   `style-vega.css`, so it wins at equal specificity).
2. If you are overriding a value Vega sets inline in the component (e.g.
   z-index), a base-layer `@apply` will not win: override inline or use
   `@apply ...!`.
3. Confirm the app root carries `class="style-vega"`; without it the `cn-*`
   rules do not apply at all.

### Component Updates

When updating breaks functionality:

1. Check the shadcn-svelte changelog.
2. Review the overlay and any inline overrides.
3. Build a consuming app before committing.
