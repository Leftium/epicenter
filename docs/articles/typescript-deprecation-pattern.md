# TypeScript Deprecation Pattern

You might think Typescript deprecations are magic and automated, but they're not. There's no magic. Deprecations are manual.

## How Deprecations Actually Work

When you see a deprecated symbol with a strikethrough in your IDE, it's just a JSDoc `@deprecated` tag. TypeScript doesn't automatically create these; you write them yourself.

## The Rename Pattern

Want to rename `A` to `B`? Here's the playbook:

1. **Rename A to B** (the actual rename)
2. **Create a new A** that equals B
3. **Mark A as deprecated**

```typescript
// Step 1: B is the new name
export type TablesSchema = Record<string, TableSchema>;

// Step 2 & 3: A becomes an alias pointing to B, marked deprecated
/**
 * @deprecated Use `TablesSchema` instead. This type will be removed in a future version.
 */
export type WorkspaceSchema = TablesSchema;
```

That's it. Old code using `WorkspaceSchema` still compiles. New code sees the strikethrough and knows to use `TablesSchema`. When you're ready, delete the deprecated alias.

## Why This Works

The deprecated alias is a real type alias; `WorkspaceSchema` and `TablesSchema` are structurally identical. You're not breaking anyone's code. You're giving them a migration path with a visual cue.

## Real Example

From `packages/epicenter/src/core/schema/fields/types.ts`:

```typescript
export type TablesSchema = Record<string, TableSchema>;

/**
 * @deprecated Use `TablesSchema` instead. This type will be removed in a future version.
 *
 * Previously named "WorkspaceSchema" but renamed to "TablesSchema" for clarity,
 * since a workspace conceptually includes both tables AND KV storage.
 */
export type WorkspaceSchema = TablesSchema;
```

The JSDoc comment explains why the rename happened. The `@deprecated` tag creates the strikethrough.

No compiler flags. No special syntax. Just a comment and a type alias.
