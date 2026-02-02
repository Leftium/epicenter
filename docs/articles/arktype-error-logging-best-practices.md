2025-11-14T09:35:56.389Z

# How to Actually Log ArkType Validation Errors

I was debugging a validation failure. The code threw an error, I checked the logs, and saw this:

```
Error: JSON validation failed: [object Object]
```

Useless. Completely useless.

Here's what I had:

```typescript
const result = schema(data);
if (result instanceof type.errors) {
  throw new Error(`Validation failed: ${result}`);
}
```

I thought JavaScript would just "figure it out". It didn't.

## The problem with toString() by default

When you coerce an object to a string in JavaScript, it calls `toString()`. For most objects, that gives you `[object Object]`. Not helpful.

But ArkType's error objects are different. They implement a custom `toString()` method that returns something useful.

## Use .summary for human-readable errors

ArkType validation errors have a `.summary` property that gives you exactly what you need:

```typescript
const User = type({
  name: 'string',
  age: 'number',
  email: 'string'
});

const result = User({ name: 'John', age: 'not a number', email: 123 });

if (result instanceof type.errors) {
  console.error(result.summary);
  // Output:
  // age must be a number (was string)
  // email must be a string (was number)
}
```

Clean. Readable. Actually tells you what went wrong.

## String coercion works too

Here's something I discovered: you can also just coerce the error to a string directly, and it works:

```typescript
if (result instanceof type.errors) {
  throw new Error(`Validation failed: ${result}`);
  // Same output as using .summary
}
```

Why? Because ArkType implements `toString()` to return the summary. When you use template literals or string concatenation, JavaScript calls `toString()` automatically.

So these are equivalent:

```typescript
console.error(result.summary);        // Explicit
console.error(`${result}`);           // Implicit (calls toString())
console.error(String(result));        // Explicit conversion
```

I prefer using `.summary` explicitly. It's clearer what you're doing. But good to know the shorthand works.

## What NOT to do

Don't use `JSON.stringify()`:

```typescript
// BAD: Gives you messy JSON with internal properties
console.error(JSON.stringify(result));
// Output: {"count":2,"summary":"age must be a number...","message":"...","by":...}
```

You get all the internal implementation details. The count. The by property. The whole mess. Nobody wants that in their logs.

## For structured logging

If you're using a structured logging system and need JSON, extract what you actually need:

```typescript
if (result instanceof type.errors) {
  logger.error('Validation failed', {
    summary: result.summary,
    count: result.count,
    errors: result.map(e => ({
      path: e.path,
      message: e.message
    }))
  });
}
```

This gives you structure without the noise. You get the error count, the summary for quick scanning, and individual error details for debugging.

## Iterating over individual errors

ArkType errors are iterable. You can loop through them:

```typescript
if (result instanceof type.errors) {
  console.error('Validation errors:');
  for (const error of result) {
    console.error(`  ${error.path}: ${error.message}`);
  }
}
```

Or use `.forEach()`:

```typescript
result.forEach(error => {
  console.error(`Path: ${error.path}, Message: ${error.message}`);
});
```

Useful when you want custom formatting or need to process each error separately.

## Real-world example

Here's what I actually use in production:

```typescript
// For user-facing errors
if (result instanceof type.errors) {
  toast.error('Invalid data', {
    description: result.summary
  });
  return;
}

// For developer logs
if (result instanceof type.errors) {
  console.error('Schema validation failed:', result.summary);
  return;
}

// For throwing errors
if (result instanceof type.errors) {
  throw new Error(`Validation failed: ${result.summary}`);
}
```

Simple. Direct. No JSON.stringify. No complex formatting. Just use `.summary` and move on.

## The pattern I follow

1. **For console logs**: Use `.summary` directly
   ```typescript
   console.error(result.summary);
   ```

2. **For throwing errors**: Include `.summary` in the message
   ```typescript
   throw new Error(`Validation failed: ${result.summary}`);
   ```

3. **For structured logging**: Extract what you need
   ```typescript
   logger.error({ summary: result.summary, count: result.count });
   ```

4. **For debugging**: Iterate over individual errors
   ```typescript
   result.forEach(e => console.log(e.path, e.message));
   ```

## Why this matters

Validation errors are usually the first sign something's wrong. If your logs don't tell you what failed and why, you waste time reproducing the issue just to see what broke.

Use `.summary`. It's right there. It's designed for this. Don't fight it with `JSON.stringify()` or hope that default `toString()` does something useful.

The lesson: ArkType gives you `.summary` because that's what you actually want to log. Use it.

For a deeper understanding of why string coercion works with ArkType errors, see [Understanding toString() vs toJSON()](./arktype-tostring-vs-tojson.md).
