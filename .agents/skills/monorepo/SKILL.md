---
name: monorepo
description: Monorepo script commands and conventions for this codebase. Use when running builds, tests, formatting, linting, or type checking.
---

# Script Commands

## Reference Repositories

- [jsrepo](https://github.com/jsrepojs/jsrepo) — Package distribution for monorepos
- [WXT](https://github.com/wxt-dev/wxt) — Browser extension framework (used by tab-manager app)

The monorepo uses consistent script naming conventions:

| Command            | Purpose                                        | When to use |
| ------------------ | ---------------------------------------------- | ----------- |
| `bun format`       | **Fix** formatting (biome)                     | Development |
| `bun format:check` | Check formatting                               | CI          |
| `bun lint`         | **Fix** lint issues (biome)                    | Development |
| `bun lint:check`   | Check lint issues                              | CI          |
| `bun typecheck`    | Type checking (tsc, svelte-check, astro check) | Both        |

## Convention

- No suffix = **fix** (modifies files)
- `:check` suffix = check only (for CI, no modifications)
- `typecheck` alone = type checking (separate concern, cannot auto-fix)

## After Completing Code Changes

Run type checking to verify:

```bash
bun typecheck
```

This runs `turbo run typecheck` which executes the `typecheck` script in each package (e.g., `tsc --noEmit`, `svelte-check`).
