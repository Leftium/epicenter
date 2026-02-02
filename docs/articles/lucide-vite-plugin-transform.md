# Use vite-plugin-transform-lucide-imports to Keep Your Preferred Syntax

I wrote about [importing Lucide icons directly from the /icons directory](../specs/20251126T095145%20fix-lucide-imports.md) to fix slow dev server times. The correct pattern looks like this:

```typescript
import Database from '@lucide/svelte/icons/database';
import MinusIcon from '@lucide/svelte/icons/minus';
import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';
```

Instead of the named import style:

```typescript
import { Database, MinusIcon, MoreVerticalIcon } from '@lucide/svelte';
```

The second pattern causes slow dev server performance because it forces the bundler to evaluate the entire barrel export to figure out which icons you actually need.

## The Problem with the Solution

I've been converting all my imports manually. It works, but there's friction:

1. You have to remember the kebab-case path (`more-vertical` not `MoreVertical`)
2. AI assistants and autocomplete still suggest the old named import pattern
3. Every new team member has to learn the pattern
4. Code review becomes a game of catching incorrect imports

## A Better Approach: Transform at Build Time

I found [vite-plugin-transform-lucide-imports](https://github.com/ieedan/vite-plugin-transform-lucide-imports) by ieedan that does exactly what you'd want: write the ergonomic named imports, let the build tool transform them to the performant direct imports.

Install it:

```bash
pnpm install vite-plugin-transform-lucide-imports -D
```

Add it to your Vite config:

```typescript
import { defineConfig } from 'vite';
import transformLucideImports from 'vite-plugin-transform-lucide-imports';

export default defineConfig({
  plugins: [/* your other plugins */, transformLucideImports()],
});
```

For SvelteKit, add it *after* the SvelteKit plugin.

## What It Does

The plugin transforms your code at build time:

```typescript
// What you write (ergonomic)
import { Database, MoreVertical as MoreVerticalIcon } from '@lucide/svelte';

// What Vite sees (performant)
import Database from '@lucide/svelte/icons/database';
import MoreVerticalIcon from '@lucide/svelte/icons/more-vertical';
```

Type imports are preserved as-is since they don't affect bundle size:

```typescript
import { type LucideIcon } from '@lucide/svelte';
// stays unchanged
```

## When to Use This

This plugin is most useful when:

- You're using older Lucide packages that don't tree-shake well
- Your dev server is noticeably slow and Lucide imports are the culprit
- You want to keep the ergonomic named import syntax your team already knows

The plugin author notes that newer Lucide packages (lucide-react, lucide-vue-next, lucide-angular) already support tree-shaking, so this may be unnecessary for those. For `@lucide/svelte`, it's still relevant.

## Trade-offs

Using the plugin:
- Keep familiar syntax
- No manual path conversion
- AI assistants and autocomplete work naturally
- Adds a build dependency

Manual conversion:
- Zero runtime or build overhead
- No dependency on a third-party plugin
- Explicit about what's happening
- Requires discipline and code review

I'm still using manual conversion in Whispering because I've already converted everything and codified the pattern in my Claude rules. But for a new project or a team that keeps forgetting the pattern, the plugin is a solid choice.
