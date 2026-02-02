# Remove `id` from defineEpicenter

## Summary

Remove the `id` field from `defineEpicenter` configuration since we're moving to Tailscale network topology where device discovery is handled by the network itself. The `id` is still needed in `defineWorkspace`.

## Motivation

The `id` field in `defineEpicenter`:

1. **Is defined** in `EpicenterConfigBase` type
2. **Is validated** in `validateEpicenterConfig`
3. **Is NOT used at runtime** - never accessed in `createEpicenterClient`

With Tailscale network topology, the epicenter ID becomes unnecessary since:

- Network discovery replaces the need for explicit epicenter identification
- Workspace IDs remain the primary sync boundary
- The `id` was purely validation overhead with no runtime benefit

## Changes

### Core Types

- [x] `config.shared.ts`: Remove `id` from `EpicenterConfigBase`, remove `TId` generic, remove validation
- [x] `config.browser.ts`: Remove `TId` generic from type and function
- [x] `config.node.ts`: Remove `TId` generic from type and function
- [x] `client.browser.ts`: Remove `TId` generic from `createEpicenterClient`
- [x] `client.node.ts`: Remove `TId` generic from `createEpicenterClient`

### Tests

- [x] `epicenter.test.ts`: Remove `id` from all `defineEpicenter` calls
- [x] `workspace.test.ts`: Remove `id` from all `defineEpicenter` calls
- [x] `cli/integration.test.ts`: Remove `id` from `defineEpicenter` calls
- [x] `cli/cli-end-to-end.test.ts`: Remove `id` from `defineEpicenter` calls
- [x] `tests/integration/server.test.ts`: Remove `id` from `defineEpicenter` calls
- [x] `tests/integration/sync.test.ts`: Remove `id` from `defineEpicenter` calls
- [x] `tests/integration/sync-client-compat.test.ts`: Remove `id` from `defineEpicenter` calls

### Examples

- [x] `examples/basic-workspace/epicenter.config.ts`: Remove `id`
- [x] `examples/content-hub/epicenter.config.ts`: Remove `id`
- [x] `examples/stress-test/epicenter.config.ts`: Remove `id`

### Documentation

- [x] `packages/epicenter/README.md`: Update examples
- [x] `packages/epicenter/src/core/epicenter/README.md`: Update examples
- [x] `packages/epicenter/src/server/README.md`: Update examples
- [x] `packages/epicenter/src/cli/README.md`: Update examples
- [x] Various spec files referencing `defineEpicenter` with `id`

## Before/After

### Before

```typescript
export type EpicenterConfigBase<
	TId extends string = string,
	TWorkspaces extends readonly AnyWorkspaceConfig[] =
		readonly AnyWorkspaceConfig[],
> = {
	id: TId;
	workspaces: TWorkspaces;
};

const epicenter = defineEpicenter({
	id: 'my-app',
	workspaces: [blogWorkspace, authWorkspace],
});
```

### After

```typescript
export type EpicenterConfigBase<
	TWorkspaces extends readonly AnyWorkspaceConfig[] =
		readonly AnyWorkspaceConfig[],
> = {
	workspaces: TWorkspaces;
};

const epicenter = defineEpicenter({
	workspaces: [blogWorkspace, authWorkspace],
});
```

## Review

Changes made successfully across 25+ files:

**Core Types (5 files)**:

- `config.shared.ts`: Removed `id` from `EpicenterConfigBase`, `TId` generic, and validation
- `config.browser.ts`: Simplified type and function signatures
- `config.node.ts`: Simplified type and function signatures
- `client.browser.ts`: Removed `TId` generic from `createEpicenterClient`
- `client.node.ts`: Removed `TId` generic from `createEpicenterClient`

**Tests (7 files)**:

- `epicenter.test.ts`: Removed `id` from all test cases
- `workspace.test.ts`: Removed `id` from all `defineEpicenter` calls
- `cli/integration.test.ts`: Updated test config
- `cli/cli-end-to-end.test.ts`: Updated test config
- `cli/load-config.test.ts`: Updated test assertions to use workspace id instead
- `tests/integration/server.test.ts`: Updated both test configs
- `tests/integration/sync.test.ts`: Updated test config
- `tests/integration/sync-client-compat.test.ts`: Updated test config

**Examples (3 files)**:

- `examples/basic-workspace/epicenter.config.ts`: Removed `id`
- `examples/content-hub/epicenter.config.ts`: Removed `id`
- `examples/stress-test/epicenter.config.ts`: Removed `id`

**CLI (1 file)**:

- `cli/server.ts`: Removed references to `config.id` in console output

**Documentation (5 files)**:

- `packages/epicenter/src/cli/README.md`
- `packages/epicenter/src/server/README.md`
- `packages/epicenter/src/core/epicenter/README.md`
- `docs/guides/handoff-yjs-persistence-rollout.md`
- `specs/20251014T101252 epicenter-server.md`

**Note**: There's a pre-existing codebase issue (missing `safe-json-schema` module) that prevents running tests, but this is unrelated to these changes. Type checking confirms no `id`-related type errors remain.
