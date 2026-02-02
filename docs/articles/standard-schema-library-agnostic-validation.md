# Standard Schema for Library-Agnostic Validation

When building a library that needs validation, you face a choice: which validation library do you depend on? Zod? ArkType? TypeBox? Each has fans who won't switch.

Standard Schema offers an escape: a common interface that validation libraries implement, allowing you to build tools that work with any of them.

## What is Standard Schema?

Standard Schema is a specification (not a library) that defines a common interface for schema validation:

```typescript
type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output>;
  };
};

type Result<Output> =
  | { value: Output; issues?: undefined }  // Success
  | { issues: Issue[] };                    // Failure
```

That's it. Any object with a `~standard` property containing a `validate` function is a Standard Schema.

## Who Implements It?

As of 2025, these libraries implement Standard Schema:

- **ArkType** - Built-in support
- **Zod** (v4.2+) - Built-in support
- **Valibot** - Built-in support
- **TypeBox** - Via adapter

This means you can write code that accepts any of these:

```typescript
function validateData<T>(schema: StandardSchemaV1<unknown, T>, data: unknown): T {
  const result = schema['~standard'].validate(data);
  if (result.issues) {
    throw new Error(result.issues[0].message);
  }
  return result.value;
}

// Works with any library:
validateData(z.string(), "hello");           // Zod
validateData(type("string"), "hello");       // ArkType
validateData(v.string(), "hello");           // Valibot
```

## Building a Union Schema

Standard Schema doesn't provide composition primitives. You can't do `schema1.or(schema2)` at the Standard Schema level because that's library-specific.

But you can build your own union wrapper:

```typescript
function createUnionSchema<T extends StandardSchemaV1[]>(
  schemas: T
): StandardSchemaV1<
  StandardSchemaV1.InferInput<T[number]>,
  StandardSchemaV1.InferOutput<T[number]>
> {
  return {
    '~standard': {
      version: 1,
      vendor: 'my-library',
      validate: (value) => {
        // Try each schema until one succeeds
        for (const schema of schemas) {
          const result = schema['~standard'].validate(value);
          if (!result.issues) return result;
        }
        return {
          issues: [{ message: 'Value did not match any schema' }]
        };
      }
    }
  };
}
```

This is O(n) - it tries each schema sequentially. For most use cases with a small number of schemas, this is fine.

## Performance Considerations

Different libraries have different performance characteristics:

| Library | Union Approach | Performance |
|---------|---------------|-------------|
| ArkType | Auto-discriminates | O(1) |
| Zod | `z.discriminatedUnion()` | O(1) with discriminator |
| Zod | `z.union()` | O(n) tries each |
| TypeBox | JIT compiled | Very fast |

If you know all your schemas are from the same library, you could optimize:

```typescript
function createOptimizedUnion(schemas: StandardSchemaV1[]) {
  const vendors = new Set(schemas.map(s => s['~standard'].vendor));

  if (vendors.size === 1 && vendors.has('arktype')) {
    // All ArkType - use native union for auto-discrimination
    return (schemas as Type[]).reduce((acc, s) => acc.or(s));
  }

  // Mixed libraries - use generic approach
  return createUnionSchema(schemas);
}
```

But in practice, the generic approach is fast enough for most cases.

## How Epicenter Uses Standard Schema

Epicenter's versioned schemas use Standard Schema unions:

```typescript
const posts = defineTable('posts')
  .version(arktypeSchema)   // ArkType schema
  .version(zodSchema)       // Could even be Zod!
  .migrate((row) => { ... });
```

Internally:
1. Collect all version schemas
2. Create a Standard Schema union
3. On read, validate against the union
4. Run migration function

This means Epicenter works with whatever validation library you prefer. Use ArkType for its speed, Zod for its ecosystem, or TypeBox for JSON Schema compatibility.

## Type Inference

Standard Schema includes type inference helpers:

```typescript
type StandardSchemaV1 {
  // ...
}

namespace StandardSchemaV1 {
  type InferInput<Schema> = Schema['~standard']['types']['input'];
  type InferOutput<Schema> = Schema['~standard']['types']['output'];
}
```

This lets you extract the TypeScript type from any Standard Schema:

```typescript
function process<T extends StandardSchemaV1>(
  schema: T,
  data: StandardSchemaV1.InferInput<T>
): StandardSchemaV1.InferOutput<T> {
  const result = schema['~standard'].validate(data);
  if (result.issues) throw new Error('Validation failed');
  return result.value;
}
```

## When to Use Standard Schema

**Use it when:**
- Building a library that needs validation but shouldn't force a specific library
- You want to support multiple validation libraries
- You're composing schemas from different sources

**Don't bother when:**
- You control the whole stack and can pick one library
- You need library-specific features (transforms, refinements, etc.)
- Performance is critical and you need library-specific optimizations

## Conclusion

Standard Schema is a simple but powerful abstraction. By programming against the interface rather than a specific library, you build tools that work for everyone.

The ecosystem is still young, but adoption is growing. As more libraries implement it, Standard Schema becomes increasingly valuable for library authors who want to stay agnostic.

For Epicenter, it means users can bring their preferred validation library. That flexibility is worth the small overhead of the generic union approach.
