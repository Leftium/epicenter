# UI Package: shadcn-svelte Management Guide

This guide explains how we manage shadcn-svelte components in our monorepo setup, including our custom configuration and best practices.

## Component Library Overview

This UI package contains a combination of:

- **shadcn-svelte** components (core design system components)
- **shadcn-svelte-extras** components (additional utility components)

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

**Decision Rule:** If the user needs to type or input data → use Modal. Otherwise, use Dialog/AlertDialog.

**Examples:**

- `ConfirmationDialog` ✅ (just yes/no buttons)
- `CreateWorkspaceModal` ✅ (multiple form inputs)
- `EditRecordingModal` ✅ (text inputs and editing)
- `DeleteWorkspaceButton` ✅ (uses AlertDialog for confirmation)

## Key Differences from Standard shadcn-svelte

### 1. Import Boundary

Apps import UI through the public package API:

```typescript
import { Button } from '@epicenter/ui/button';
import { cn } from '@epicenter/ui/utils';
import '@epicenter/ui/app.css';
```

Files inside `packages/ui/src` import other UI files with package-private
imports from `package.json#imports`:

```typescript
import { Button } from '#ui/button';
import { cn } from '#utils';
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

The UI package owns its internal import names through `package.json#imports`.
Apps should never define them.

### 2. Package Imports and Exports Structure

Our `package.json` has two separate maps:

- `imports` is private to `packages/ui` source.
- `exports` is public API for app consumers.

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
	},
	"exports": {
		"./*": "./src/*/index.ts",
		"./utils": "./src/utils.ts",
		"./utils/*": "./src/utils/*.ts",
		"./app.css": "./src/app.css"
	}
}
```

This allows UI source to import components like:

```typescript
import { Button } from '#ui/button';
import { cn } from '#utils';
```

It allows consumers to import components like:

```typescript
import { Button } from '@epicenter/ui/button';
import { cn } from '@epicenter/ui/utils';
```

### 3. Styling Override Pattern

When extending shadcn-svelte components with custom styles, we use a specific pattern that separates base styles from our overrides:

```svelte
<SelectPrimitive.Content
	class={cn(
		'base-shadcn-styles-here',
		// Custom override: prevents dropdown from expanding
		'max-w-min',
		className,
	)}
/>
```

**Why use separate arguments in `cn()`?**

- **Clear separation**: First argument contains shadcn's base styles, second argument contains our overrides
- **Better diffs**: When updating shadcn components, changes to base styles appear in the first argument, making it obvious what shadcn changed vs. what we customized
- **Comments**: We can add comments above our overrides explaining why they're needed
- **Easier updates**: During `shadcn-svelte` updates, if our override (second argument) disappears in the diff, we know we need to re-apply it

This pattern makes component updates much clearer: shadcn's style updates show in the first `cn()` argument, while our customizations remain visually separate in subsequent arguments.

## Component Management Workflow

### Adding New Components

```bash
# Add a new component
bun x shadcn-svelte@latest add dialog

# The component will be added to packages/ui/src/dialog/
```

### Updating Components

1. Run the add command with the `--overwrite` flag:

   ```bash
   bun x shadcn-svelte@latest add dialog --overwrite
   ```

2. Review the diff carefully, especially:
   - Custom style overrides (marked with comments)
   - Import path changes
   - Any custom props or functionality

### Import Path Convention

Use package imports within the UI package and public package imports from apps:

```typescript
// App code
import { Button } from '@epicenter/ui/button';

// UI package source
import { Button } from '#ui/button';
import { cn } from '#utils';
```

## Directory Structure

```
packages/ui/
├── src/
│   ├── accordion/
│   │   ├── accordion.svelte
│   │   ├── accordion-content.svelte
│   │   ├── accordion-item.svelte
│   │   ├── accordion-trigger.svelte
│   │   └── index.ts
│   ├── button/
│   │   ├── button.svelte
│   │   └── index.ts
│   ├── utils.ts
│   └── app.css
├── components.json
├── package.json
├── tsconfig.json
└── tsconfig.shadcn.json
```

## Best Practices

1. **Keep Components Pure**: Don't add business logic to UI components
2. **Use Barrel Exports**: Each component folder should have an `index.ts`
3. **Document Overrides**: Always comment custom style additions
4. **Test After Updates**: Verify components work after shadcn updates
5. **Consistent Imports**: Use `#ui`, `#utils`, `#hooks`, and `#lib` inside `packages/ui/src`

## Boundary Check

Run the boundary check after changing UI imports or app config:

```bash
bun run check:ui-boundary
```

The executable source of truth is `scripts/check-ui-boundary.ts`.
The check fails when app configs point at `packages/ui/src`, when app tsconfigs
add private UI import paths, when app source imports private UI import names,
when app or package source imports `packages/ui/src` directly, or when UI source
imports itself through naked `#`, `#/...`, or `@epicenter/ui/...`.

`components.json` and `tsconfig.shadcn.json` are shadcn-svelte generator input.
They keep the CLI usable because shadcn requires aliases backed by a TypeScript
config. Keep that compatibility in `tsconfig.shadcn.json`; do not merge it into
the package's real `tsconfig.json`.

The real source resolver is `package.json#imports`. That is why `#utils` works
in source without any SvelteKit app alias, and why `#/utils` is not used.

## Troubleshooting

### Import Resolution Issues

If imports aren't resolving:

1. Check that the component is exported by `@epicenter/ui`
2. Ensure your IDE recognizes the package's TypeScript config
3. Restart the TypeScript language server

### Style Conflicts

If custom styles aren't applying:

1. Check the order in the `cn()` function
2. Ensure custom styles come after base styles
3. Use more specific selectors if needed

### Component Updates

When updating breaks functionality:

1. Check the shadcn-svelte changelog
2. Review our custom overrides
3. Test thoroughly before committing
