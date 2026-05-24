# Three Parts, One ID: Type the Brand, Validate the Schema, Generate the Value

Every generated branded ID in the workspace codebase follows the same three-part pattern. The type brands the string, the validator slots into `defineTable()` schemas, and the generator wraps `generateId()` so the cast lives in one place. A `SavedTabId` with all three parts looks like this:

```typescript
export type SavedTabId = Id & Brand<'SavedTabId'>;
export const SavedTabId = type('string').as<SavedTabId>();
export const generateSavedTabId = (): SavedTabId =>
  generateId() as SavedTabId;
```

## Extend the base Id type to simplify the factory cast

The base type extends `Id` (which is `string & Brand<'Id'>`) rather than bare `string`. This means the factory only needs a single cast (`generateId() as SavedTabId`) instead of the double cast (`generateId() as string as SavedTabId`). Since `generateId()` returns `Id`, the types are compatible without stripping the brand first.

```typescript
// Good: compatible with generateId()
export type SavedTabId = Id & Brand<'SavedTabId'>;

// Bad: requires double cast
export type SavedTabId = string & Brand<'SavedTabId'>;
```

## Use .as<>() for zero-cost type assertions in Arktype

Both `.as<>()` and `.pipe()` create the same runtime validator, but `.as<>()` is a zero-cost type assertion. Arktype knows the output type without a pipe function, which keeps the schema definition clean. The pipe version is three lines of ceremony for the same result.

```typescript
// Good: concise and zero-cost
export const SavedTabId = type('string').as<SavedTabId>();

// Bad: unnecessary ceremony
export const SavedTabId = type('string').pipe((s): SavedTabId => s as SavedTabId);
```

## Distinguish generators from constructors with the generate prefix

The codebase distinguishes generators from constructors. `generate*` means a new ID from scratch that calls `generateId()` or nanoid. `create*` means assembling an ID from inputs, like `createTabCompositeId(deviceId, tabId)`. Both are factory functions, but the prefix signals the difference.

```typescript
// New ID from scratch
export const generateSavedTabId = (): SavedTabId => generateId() as SavedTabId;

// Assembled from inputs
export const createTabCompositeId = (deviceId: DeviceId, tabId: TabId): TabCompositeId =>
  `${deviceId}:${tabId}` as TabCompositeId;
```

## Each part serves a specific purpose in the schema

| Part | When to use |
| --- | --- |
| Validator | Used in `defineTable()` or arktype schemas, and as `.assert(...)` at `unknown` boundaries |
| Type | Always — derived from the validator via `typeof X.infer` or declared alongside it |
| Third part | A helper sized to where the value comes from (see below) |

The third part flexes by ID origin:

| Origin of the value                         | Third part                                        | Example                                                                |
| ------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| Minted fresh by this code                   | `generateXxx()` wrapping `generateId() as Xxx`    | `generateSavedTabId` in `apps/tab-manager/src/lib/workspace.ts`        |
| Received as a typed string (auth, URL, DB)  | `asXxx(value: string)` syntactic-sugar helper     | `asUserId`, `asOwnerId` in `packages/auth/src/ids.ts`                  |
| Received as `unknown` at a network boundary | None — use the validator or `.assert(unknown)`    | `PersistedAuth.assert(...)` at machine-auth deserialization            |
| Set from an external source, never minted   | `asXxx` helper                                    | `asDeviceId` would belong here if installation ids needed grep sites   |

## The `as*` variant for external-source IDs

When the ID is not minted but received as a typed `string` from another typed source — Better Auth's `c.var.user.id`, a Hono URL param, a DB column — the third part is an `as*` syntactic-sugar helper instead of a generator:

```typescript
// packages/auth/src/ids.ts
export const UserId = type('string').as<string & Brand<'UserId'>>();
export type UserId = typeof UserId.infer;

/**
 * Syntactic sugar for `value as UserId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast. The only place `as UserId` appears.
 */
export const asUserId = (value: string): UserId => value as UserId;
```

The validator can be declared first (as above) and the type inferred via `typeof UserId.infer`, or the type can be declared first with the brand alongside it and the validator declared as `type('string').as<UserId>()`. Both shapes are in the repo; prefer validator-first for new code so the validator stays the single source of truth.

You can find the canonical generator implementation with 7 branded types and 4 generators in `apps/tab-manager/src/lib/workspace.ts`, and the canonical `as*` variant in `packages/auth/src/ids.ts`. Every ID in the system stays type-safe and validated at the boundary without leaking implementation details.
