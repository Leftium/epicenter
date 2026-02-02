# CLI Architecture Cleanup

**Status:** In Progress  
**Created:** 2026-01-08  
**Author:** Braden Wong

## Overview

Refactor the CLI module to separate concerns: JSON Schema to yargs conversion, command building, and CLI registration. This addresses the "stilted" feel of the current implementation where conversion, building, and registration are tangled together.

## Background

### Current State

The current `cli.ts` has several issues:

1. **Tangled concerns**: JSON Schema → yargs conversion happens inline within the command registration loop
2. **Mutation-heavy pattern**: `result = result.command(...) as Argv<T>` repeated in a loop
3. **Type casting**: `as Argv<T>`, `as Record<string, unknown>` throughout
4. **Duplicate validation**: Yargs validates options, then action validator re-validates

### History

- **PR #1199**: Contract/handler separation introduced complex action system
- **PR #1209**: Removed action system entirely (~1,820 lines), including `standard-json-schema-to-yargs.ts` (430 lines)
- **Current**: Simplified action system restored, but CLI registration logic is still awkward

### Inspiration

The **server** implementation (`server/actions.ts`) handles the same data much more elegantly with Elysia's route registration. The CLI should follow a similar pattern: build command configs first, then register.

Cloudflare Wrangler's yargs pattern uses a `createRegisterYargsCommand` factory that separates definition from registration.

## Proposed Architecture

```
cli/
├── cli.ts                      # Main createCLI, clean registration loop
├── json-schema-to-yargs.ts     # JSON Schema → yargs options conversion
├── command-builder.ts          # Build command configs from actions
├── bin.ts                      # Entry point (unchanged)
└── index.ts                    # Exports
```

### Data Flow

```
Actions (nested tree)
    ↓ iterateActions()
[Action, path][] tuples
    ↓ buildActionCommands()
CommandConfig[] (pure data)
    ↓ register loop
yargs instance with commands
```

## Implementation

### 1. `json-schema-to-yargs.ts`

Clean conversion utility using arktype's `JsonSchema` type with proper type guards.

**Key design decisions:**

- Use arktype's `JsonSchema` type (already a dependency)
- Proper type guards for discriminated union (`isObjectSchema`, `isEnumSchema`, etc.)
- Returns `Record<string, Options>` not a mutated yargs instance
- Permissive philosophy: if we can't represent a type, omit the type constraint and let action validation handle it

### 2. `command-builder.ts`

Builds command configurations from actions without registering them.

**Key design decisions:**

- Returns `CommandModule[]` (yargs' command config type)
- Pure function: actions in, configs out
- Handler creation separated into its own function
- Input extraction logic isolated

### 3. `cli.ts` (refactored)

Now just orchestrates: create base CLI, build commands, register them.

**Key design decisions:**

- No inline schema conversion
- Clean registration loop: `for (const cmd of commands) cli = cli.command(cmd)`
- Cleanup logic remains the same

## Files Changed

| File                          | Change                                        |
| ----------------------------- | --------------------------------------------- |
| `cli/json-schema-to-yargs.ts` | NEW: JSON Schema → yargs options              |
| `cli/command-builder.ts`      | NEW: Build command configs from actions       |
| `cli/cli.ts`                  | REFACTOR: Use new modules, clean registration |
| `cli/index.ts`                | UPDATE: Export new utilities if needed        |

## Comparison

### Before (tangled)

```typescript
function registerActionCommands<T>(cli: Argv<T>, actions: Actions): Argv<T> {
	let result = cli;
	for (const [action, path] of iterateActions(actions)) {
		result = result.command(
			path.join(' '),
			description,
			(yargs) => {
				if (action.input) {
					const jsonSchema = generateJsonSchema(action.input);
					return addOptionsFromJsonSchema(yargs, jsonSchema); // inline conversion!
				}
				return yargs;
			},
			async (argv) => {
				/* handler */
			},
		) as Argv<T>; // type casting!
	}
	return result;
}
```

### After (separated)

```typescript
// json-schema-to-yargs.ts
export function jsonSchemaToYargsOptions(schema: JsonSchema): Record<string, Options> { ... }

// command-builder.ts
export function buildActionCommands(actions: Actions): CommandModule[] {
  return [...iterateActions(actions)].map(([action, path]) => ({
    command: path.join(' '),
    describe: action.description,
    builder: action.input ? jsonSchemaToYargsOptions(generateJsonSchema(action.input)) : {},
    handler: createActionHandler(action),
  }));
}

// cli.ts
const commands = options?.actions ? buildActionCommands(options.actions) : [];
for (const cmd of commands) {
  cli = cli.command(cmd);
}
```

## Todo

- [x] Create spec
- [ ] Create `cli/json-schema-to-yargs.ts`
- [ ] Create `cli/command-builder.ts`
- [ ] Refactor `cli/cli.ts`
- [ ] Update `cli/index.ts` exports
- [ ] Run typecheck
- [ ] Test manually

## Review

### Changes Made

| File                          | Lines | Change                                                            |
| ----------------------------- | ----- | ----------------------------------------------------------------- |
| `cli/json-schema-to-yargs.ts` | 167   | NEW: Clean JSON Schema → yargs conversion with proper type guards |
| `cli/command-builder.ts`      | 90    | NEW: Build command configs from actions tree                      |
| `cli/cli.ts`                  | 68    | REFACTORED: Now uses new modules, clean registration loop         |

### Before/After Comparison

**Before (cli.ts):** 203 lines with tangled concerns

- Inline JSON Schema conversion in `addOptionsFromJsonSchema`
- Mutation loop with `result = result.command(...) as Argv<T>`
- Type casting throughout
- `extractInputFromArgv` mixed with registration logic

**After:**

- `cli.ts`: 68 lines, clean orchestration
- `json-schema-to-yargs.ts`: 167 lines, focused conversion with arktype's `JsonSchema` type
- `command-builder.ts`: 90 lines, pure function building command configs

### Key Improvements

1. **Separation of concerns**: Conversion, building, and registration are now separate
2. **Type safety**: Uses arktype's `JsonSchema` discriminated union with proper type guards
3. **Cleaner registration**: `for (const cmd of commands) cli = cli.command(cmd)`
4. **Testability**: `buildActionCommands` returns pure data, easy to unit test
5. **Reusability**: `jsonSchemaToYargsOptions` could be exported for custom CLI building

### Verification

- [x] `bun run typecheck` passes
- [x] No type errors in new files
- [x] Existing exports unchanged (`createCLI`, `findProjectDir`, `loadClients`)
