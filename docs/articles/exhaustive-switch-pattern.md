# The Exhaustive Switch Pattern

You're switching on a discriminated union. You've got `query` and `mutation`. Two cases, two code paths. Done, right?

What happens six months from now when someone adds `subscription`?

Nothing. The code silently falls through. No compile error. No runtime warning. Just a bug waiting to surface in production.

## The Pattern

```typescript
switch (action.type) {
	case 'query':
		router.get(routePath, handler, { query: action.input, detail });
		break;
	case 'mutation':
		router.post(routePath, handler, { body: action.input, detail });
		break;
	default: {
		// Gives type warning if not never
		const _exhaustive: never = action;
		// Gives runtime exception if invariant is violated
		throw new Error(`Unknown action type: ${_exhaustive}`);
	}
}
```

Two lines in the default case. That's it.

## Why It Works

The `never` type in TypeScript represents values that should never exist. When you assign `action.type` to a variable typed as `never`, TypeScript checks: "Can this value actually reach this point?"

If you've handled all cases, the answer is no. `action.type` is `'query' | 'mutation'`, both are handled, so the default is unreachable. TypeScript is happy.

Now add a new type:

```typescript
type ActionType = 'query' | 'mutation' | 'subscription';
```

Suddenly `action.type` in the default case could be `'subscription'`. You can't assign `'subscription'` to `never`. TypeScript screams at you. You fix it before the code ever runs.

## The Underscore Prefix

The `_exhaustive` variable is intentionally unused. The underscore signals to linters and readers: "This exists for the type system, not for runtime logic."

Some teams use `_` alone, some use `_never`, some use `_exhaustive`. Pick one and be consistent.

## Defense in Depth

The runtime `throw` might seem redundant. If TypeScript catches all missing cases at compile time, why throw?

Because TypeScript isn't omniscient. Consider:

- External data parsed with `as ActionType`
- JSON from an API with a new type your code doesn't know about
- Version mismatches between services
- Tests that bypass type checking

The throw is your last line of defense. If impossible happens, fail loudly and immediately. The error message includes the actual value (`${_exhaustive}`), making debugging trivial.

## When to Use It

Any switch on a discriminated union where:

- New variants might be added over time
- Missing a case would cause subtle bugs
- You want compile-time + runtime guarantees

Common scenarios:

- Action types (query/mutation/subscription)
- State machine states
- Event types
- Message kinds
- API response discriminators

## The Alternative (Don't Do This)

```typescript
switch (action.type) {
	case 'query':
		// ...
		break;
	case 'mutation':
		// ...
		break;
	// No default - TypeScript won't warn you
}
```

This compiles. It runs. It silently does nothing for new types. Months later someone files a bug report and you spend hours tracking down what should have been a compile error.

## Summary

Two lines. Compile-time exhaustiveness checking. Runtime safety net. Clear error messages.

```typescript
default: {
    const _exhaustive: never = action;
    throw new Error(`Unknown action type: ${_exhaustive}`);
}
```

Add it to every switch on a discriminated union. Future you will be grateful.
