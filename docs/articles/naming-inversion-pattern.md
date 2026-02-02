# Naming Inversion

Name things by how they're **used**, not how they're created. The thing you interact with most gets the simple name.

## Type Inversion

When you have a factory function and its return type, the return type gets the clean name.

```typescript
// Before: factory gets the good name
type Action = () => ActionExports;
type ActionExports = { ... };

// After: what you USE gets the good name
type ActionFactory = () => Actions;
type Actions = { ... };
```

Real example from this codebase:

- `ProviderExports` → `Providers` (the thing you use)
- `ActionExports` → `Actions` (the thing you call)

## Variable Inversion

The final form of data gets the clean name. Earlier stages get prefixes.

```typescript
// Before: final form has the longest name
const input = getInput();
const parsedInput = JSON.parse(input);
const validatedInput = validate(parsedInput);
doStuff(validatedInput); // verbose

// After: final form has the clean name
const rawInput = getInput();
const parsed = JSON.parse(rawInput);
const input = validate(parsed);
doStuff(input); // clean
```

The variable you use 10 times shouldn't have a suffix on it.
