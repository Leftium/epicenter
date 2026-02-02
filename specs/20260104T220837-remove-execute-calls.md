# Remove Redundant `.execute()` Calls from Query Layer

**Created**: 2026-01-04T22:08:37
**Status**: Completed
**Branch**: `refactor/remove-execute-calls`

## Summary

Simplify the codebase by removing redundant `.execute()` method calls on mutations. Since wellcrafted v0.26.0, mutation definitions are directly callable functions, making `.execute()` unnecessary.

## Background

The wellcrafted library (v0.26.0+) made query and mutation definitions directly callable:

```typescript
const createUser = defineMutation({...});

// OLD: Explicit .execute() call
const { data, error } = await createUser.execute({ name: 'John' });

// NEW: Direct call (recommended)
const { data, error } = await createUser({ name: 'John' });
```

Both patterns are equivalent; they reference the same function. The direct call is now the recommended primary pattern.

## Implementation Details

### How It Works (from wellcrafted source)

```typescript
// wellcrafted uses Object.assign to make the function callable with properties
async function execute(variables: TVariables) {
	try {
		return Ok(await runMutation(queryClient, newOptions, variables));
	} catch (error) {
		return Err(error as TError);
	}
}

return Object.assign(execute, {
	options: newOptions, // Static property (not a function!)
	execute, // Same function reference
});
```

### Current State

~297 `.execute()` calls across the codebase in `apps/whispering/src/`:

```bash
# Common patterns to replace:
rpc.notify.error.execute(error)           → rpc.notify.error(error)
rpc.db.recordings.delete.execute(rec)     → rpc.db.recordings.delete(rec)
rpc.recorder.startRecording.execute({})   → rpc.recorder.startRecording({})
notify.loading.execute({ id, ...opts })   → notify.loading({ id, ...opts })
```

## Tasks

- [x] Verify wellcrafted version in package.json is >= 0.26.0
- [x] Create find/replace patterns for common `.execute()` calls
- [x] Update files in `apps/whispering/src/routes/`
- [x] Update files in `apps/whispering/src/lib/query/`
- [x] Update files in `apps/whispering/src/lib/components/`
- [x] Update files in `apps/whispering/src/lib/stores/`
- [x] Update files in `apps/whispering/src/lib/commands.ts`
- [x] Update files in `apps/whispering/src/lib/utils/`
- [x] Run type check to ensure no regressions
- [ ] Run build to verify everything compiles (skipped - typecheck passed)
- [ ] Update query-layer skill documentation to reflect direct calling as primary pattern (deferred)
- [ ] Update query/README.md if it references `.execute()` (deferred - docs update separate PR)

## Replacement Patterns

### Simple Replacements (AST-grep or regex)

```
# Pattern 1: rpc.X.Y.execute(args)
OLD: rpc.notify.error.execute(error)
NEW: rpc.notify.error(error)

# Pattern 2: variable.execute(args)
OLD: notify.loading.execute({ id: toastId, ...options })
NEW: notify.loading({ id: toastId, ...options })

# Pattern 3: Chained access
OLD: await rpc.db.recordings.delete.execute(recording)
NEW: await rpc.db.recordings.delete(recording)
```

### Edge Cases to Watch

1. **Destructured imports**: If someone destructured `execute`, it still works
2. **Type annotations**: Some explicit `ReturnType<typeof x.execute>` may need updating
3. **Documentation**: Comments referencing `.execute()` should be updated

## Testing Strategy

1. **Type check**: `bun run typecheck` (or equivalent)
2. **Build**: `bun run build`
3. **Manual smoke test**: Start the app and test recording/transcription flow

## Notes

- `.execute()` still works and isn't deprecated; this is purely a simplification
- The change is cosmetic but improves code readability
- No runtime behavior changes
- `.options` is already a property (changed in v0.26.0), not `.options()`

## Review

**Completed**: 2026-01-04

### Summary of Changes

- Removed ~250 `.execute()` calls across 45 files in `apps/whispering/src/`
- Used ast-grep for bulk replacements with pattern `$OBJ.execute($ARGS)` → `$OBJ($ARGS)`
- Preserved service method calls (`CommandServiceLive.execute()`, `services.command.execute()`) which are actual methods, not query mutations

### Key Files Changed

| File                               | Changes                         |
| ---------------------------------- | ------------------------------- |
| `lib/query/isomorphic/actions.ts`  | 128 replacements (largest file) |
| `lib/query/isomorphic/delivery.ts` | 60 replacements                 |
| `lib/commands.ts`                  | 22 replacements                 |
| Various `.svelte` route files      | ~40 replacements                |

### Verification

- **Typecheck**: Passed (0 new errors from changes)
- **Pre-existing errors**: 7 in `packages/ui` (unrelated button components)
- **Wellcrafted version**: ^0.29.1 (>= 0.26.0 ✅)

### Deferred Work

- Update `apps/whispering/src/lib/query/README.md` to document direct calling as primary pattern
- Update query-layer skill documentation

## References

- [wellcrafted v0.26.0 changelog](https://github.com/wellcrafted-dev/wellcrafted/blob/main/CHANGELOG.md)
- [wellcrafted spec: callable-query-mutation](https://github.com/wellcrafted-dev/wellcrafted/blob/main/specs/20251204T024300-callable-query-mutation.md)
- [wellcrafted source: Object.assign pattern](https://github.com/wellcrafted-dev/wellcrafted/blob/main/src/query/utils.ts#L510-L515)
