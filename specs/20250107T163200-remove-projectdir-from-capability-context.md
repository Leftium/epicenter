# Remove projectDir from Capability Context

**Date**: 2025-01-07
**Status**: Planning

## Summary

Remove `paths` from `CapabilityContext` and `projectDir` from `CreateOptions`. Capabilities receive paths explicitly via their config instead of through injected context.

## Motivation

Currently, `projectDir` flows through the system:

1. `.create({ projectDir })`
2. `initializeWorkspace()` builds `CapabilityPaths` for each capability
3. Every capability receives `paths` in context

**Problems**:

- Implicit coupling: All capabilities get the same `projectDir`
- Complex context: `CapabilityContext` includes environment-specific `paths`
- Browser awkwardness: `paths` is `undefined` in browser, requiring `if (!paths) throw...` checks
- Hidden behavior: Path resolution happens inside the framework

**Solution**: Each capability explicitly declares what paths it needs via config.

## Changes Required

### 1. Remove from `CapabilityContext` (`src/core/capability.ts`)

```typescript
// BEFORE
export type CapabilityContext<...> = {
  id: string;
  capabilityId: string;
  ydoc: Y.Doc;
  tables: Tables<TTablesSchema>;
  kv: Kv<TKvSchema>;
  paths: CapabilityPaths | undefined;  // REMOVE
};

// AFTER
export type CapabilityContext<...> = {
  id: string;
  capabilityId: string;
  ydoc: Y.Doc;
  tables: Tables<TTablesSchema>;
  kv: Kv<TKvSchema>;
};
```

### 2. Remove `CreateOptions` entirely (`src/core/workspace/contract.ts`)

```typescript
// BEFORE
export type CreateOptions = {
	projectDir?: string;
};

// Remove this type entirely
// .create() takes no arguments
```

### 3. Remove from `WorkspaceClient` (`src/core/workspace/contract.ts`)

```typescript
// BEFORE
export type WorkspaceClient<...> = {
  // ...
  paths: WorkspacePaths | undefined;  // REMOVE
  // ...
};

// AFTER: No paths field
```

### 4. Simplify `initializeWorkspace()` (`src/core/workspace/contract.ts`)

```typescript
// BEFORE
async function initializeWorkspace(..., options?: CreateOptions) {
  const projectDir = options?.projectDir ?? process.cwd();

  // Build paths for each capability
  let buildCapabilityPaths = ...;

  const paths = projectDir && buildCapabilityPaths
    ? buildCapabilityPaths(projectDir, capabilityId)
    : undefined;

  await capabilityFn({ id, capabilityId, ydoc, tables, kv, paths });
}

// AFTER
async function initializeWorkspace(...) {
  // No path building!
  await capabilityFn({ id, capabilityId, ydoc, tables, kv });
}
```

### 5. Update Capabilities to receive paths via config

#### persistence (`src/capabilities/persistence/desktop.ts`)

```typescript
// BEFORE
export const persistence = async ({ id, ydoc, paths }) => {
	if (!paths) throw new Error('Requires Node.js');
	const filePath = path.join(paths.capability, `${id}.yjs`);
	// ...
};

// AFTER
export type PersistenceConfig = {
	/** Absolute path to the .yjs file */
	filePath: string;
};

export const persistence = async (
	{ id, ydoc }: CapabilityContext,
	config: PersistenceConfig,
) => {
	const { filePath } = config;
	mkdirSync(path.dirname(filePath), { recursive: true });
	// ...
};
```

#### sqlite (`src/capabilities/sqlite/sqlite-provider.ts`)

```typescript
// BEFORE
export const sqlite = async ({ id, tables, paths }, options) => {
	if (!paths) throw new Error('Requires Node.js');
	const databasePath = path.join(paths.capability, `${id}.db`);
	const logsDir = path.join(paths.capability, 'logs');
	// ...
};

// AFTER
export type SqliteConfig = {
	/** Absolute path to the .db file */
	dbPath: string;
	/** Absolute path to logs directory (optional) */
	logsDir?: string;
	/** Debounce interval in ms (default: 100) */
	debounceMs?: number;
};

export const sqlite = async (
	{ id, tables }: CapabilityContext,
	config: SqliteConfig,
) => {
	const { dbPath, logsDir, debounceMs = 100 } = config;
	await mkdir(path.dirname(dbPath), { recursive: true });
	// ...
};
```

#### markdown (`src/capabilities/markdown/markdown-provider.ts`)

```typescript
// BEFORE
export type MarkdownProviderConfig = {
  directory?: string;  // Resolved relative to projectDir
  tableConfigs?: ...;
};

export const markdown = async (context, config) => {
  const { paths } = context;
  if (!paths) throw new Error('Requires Node.js');

  const { project: projectDir, epicenter: epicenterDir } = paths;
  const absoluteWorkspaceDir = path.resolve(projectDir, config.directory ?? `./${id}`);
  // ...
};

// AFTER
export type MarkdownProviderConfig = {
  /** Absolute path to markdown files directory */
  directory: string;  // Required, must be absolute
  /** Absolute path to logs directory (optional) */
  logsDir?: string;
  /** Absolute path to diagnostics JSON file (optional) */
  diagnosticsPath?: string;
  tableConfigs?: ...;
};

export const markdown = async (
  context: CapabilityContext,
  config: MarkdownProviderConfig
) => {
  const { id, tables, ydoc, capabilityId } = context;
  const { directory, logsDir, diagnosticsPath, tableConfigs } = config;
  // directory is already absolute - no resolution needed
  // ...
};
```

### 6. Export path utilities for users (`src/core/paths.ts`)

Keep these exported so users can build paths themselves:

```typescript
// Already exported, keep as-is
export function getEpicenterDir(projectDir: string): string;
export function getCapabilityDir(
	epicenterDir: string,
	capabilityId: string,
): string;
export function buildCapabilityPaths(
	projectDir: string,
	capabilityId: string,
): CapabilityPaths;
```

## Usage Examples

### BEFORE

```typescript
const client = await workspace
	.withCapabilities({
		persistence,
		sqlite: (c) => sqlite(c),
		markdown: (c) => markdown(c, { directory: './vault' }),
	})
	.create({ projectDir: '/my/project' });
```

### AFTER (Option 1: Explicit paths)

```typescript
const projectDir = '/my/project';
const epicenterDir = join(projectDir, '.epicenter');

const client = await workspace
  .withCapabilities({
    persistence: (ctx) => persistence(ctx, {
      filePath: join(epicenterDir, 'persistence', `${ctx.id}.yjs`),
    }),
    sqlite: (ctx) => sqlite(ctx, {
      dbPath: join(epicenterDir, 'sqlite', `${ctx.id}.db`),
      logsDir: join(epicenterDir, 'sqlite', 'logs'),
    }),
    markdown: (ctx) => markdown(ctx, {
      directory: join(projectDir, 'vault'),
      logsDir: join(epicenterDir, 'markdown', 'logs'),
      diagnosticsPath: join(epicenterDir, 'markdown', `${ctx.id}.diagnostics.json`),
      tableConfigs: { ... },
    }),
  })
  .create();
```

### AFTER (Option 2: Helper function)

```typescript
import { buildEpicenterPaths } from '@epicenter/hq';

const paths = buildEpicenterPaths('/my/project');

const client = await workspace
  .withCapabilities({
    persistence: (ctx) => persistence(ctx, {
      filePath: paths.persistence(ctx.id)
    }),
    sqlite: (ctx) => sqlite(ctx, paths.sqlite(ctx.id)),
    markdown: (ctx) => markdown(ctx, {
      ...paths.markdown(ctx.id),
      directory: join(paths.projectDir, 'vault'),
      tableConfigs: { ... },
    }),
  })
  .create();
```

## Files to Modify

- [ ] `src/core/capability.ts` - Remove `paths` from `CapabilityContext`
- [ ] `src/core/workspace/contract.ts` - Remove `CreateOptions`, `projectDir` logic, `paths` from `WorkspaceClient`
- [ ] `src/core/types.ts` - Keep types but update docs
- [ ] `src/core/paths.ts` - Keep as utility exports
- [ ] `src/capabilities/persistence/desktop.ts` - Add `PersistenceConfig`, remove `paths` usage
- [ ] `src/capabilities/sqlite/sqlite-provider.ts` - Update config type, remove `paths` usage
- [ ] `src/capabilities/markdown/markdown-provider.ts` - Update config type, remove `paths` usage
- [ ] `src/core/provider.shared.ts` - Update if needed
- [ ] `packages/epicenter/README.md` - Update documentation
- [ ] `examples/basic-workspace/.epicenter/workspaces/blog.workspace.ts` - Update usage

## Migration for Existing Code

Existing code using `paths` from context:

```typescript
// BEFORE
const myCapability = ({ id, paths }) => {
	const filePath = join(paths.capability, `${id}.json`);
};

// AFTER
type MyCapabilityConfig = { filePath: string };
const myCapability = (
	{ id }: CapabilityContext,
	config: MyCapabilityConfig,
) => {
	const { filePath } = config;
};
```

## Benefits

1. **Explicit over implicit**: See exactly where each capability stores data
2. **Flexibility**: Different capabilities can use different base directories
3. **Simpler context**: `CapabilityContext` is just workspace primitives
4. **No environment detection**: No more `if (!paths) throw...` checks
5. **Browser simplicity**: Browser capabilities don't get undefined paths
6. **Testability**: Easier to test with mock paths

## Trade-offs

1. **More verbose**: Need to pass paths explicitly
2. **Helper needed**: May want `buildEpicenterPaths()` helper for convenience

## Review

_To be filled after implementation_
