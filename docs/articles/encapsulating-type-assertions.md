# Encapsulating Type Assertions: The Callback Pattern

TL;DR: Co-locate `@ts-expect-error` into one function that handles assertions internally, keeping your business logic type-safe.

## The Problem

TypeScript evaluates union types independently. Even if you know two variables are correlated (like a database `table` and its corresponding `row` data), TypeScript treats them as independent unions during iteration.

This limitation, tracked in [TypeScript issue #35101](https://github.com/microsoft/TypeScript/issues/35101), often results in business logic littered with `@ts-expect-error` comments.

### Before: Scattered Assertions

In this example, business logic is cluttered with assertions because TypeScript can't guarantee that `table` matches the `row` type.

```typescript
for (const { table, row } of updates) {
	// @ts-expect-error: table and row are not correlated unions
	table.validate(row);
	// @ts-expect-error: another assertion required for use
	table.insert(row);
}
```

## The Pattern

Instead of asserting at every usage site, encapsulate the type assertion within a helper function. This reduces N assertions to a single assertion at the helper call site, keeping the logic inside the callback fully type-safe.

### After: Encapsulated Callback

By wrapping the logic in a generic helper, we bind the types at the call site.

```typescript
for (const { table, row } of updates) {
	// Single assertion point
	// @ts-expect-error: union type correlation
	withTablePair(table, row, ({ table, row }) => {
		// The code here is now fully type-safe!
		table.validate(row);
		table.insert(row);
	});
}
```

## The Helper Pattern

The implementation uses generics to force TypeScript to treat parameters as concrete, paired types within the scope of the callback.

```typescript
function withTablePair<TTable extends TableHelper<any>, TRow>(
	table: TTable,
	row: TRow,
	callback: (ctx: { table: TTable; row: TRow }) => void,
) {
	callback({ table, row });
}
```

## The Rule of Thumb

When you see `@ts-expect-error` scattered across multiple call sites, it's a code smell. Extract the logic into a helper that accepts a callback. Assert once at the boundary, and enjoy type safety everywhere else.

## Why It Works

When you call `withTablePair`, the generic parameters are bound to specific types. Inside the callback, these are no longer treated as unions; they are concrete types that satisfy the generic constraints.

TypeScript essentially says: "I don't know if this specific `table` and `row` from the loop are compatible, but I know that _whatever_ types they are, they must satisfy the generic signature inside the callback."
