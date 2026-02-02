# TypeBox is a Beast

TypeBox is deceptively simple. At its core, everything in TypeBox is just a thin wrapper around JSON Schema. When you call `Type.Object()`, you're not creating some proprietary runtime type; you're building a plain JSON Schema object that happens to also infer TypeScript types.

## It's Just JSON Schema

```typescript
import { Type } from 'typebox';

const UserSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	email: Type.String(),
});

console.log(JSON.stringify(UserSchema, null, 2));
```

Output:

```json
{
	"type": "object",
	"required": ["id", "name", "email"],
	"properties": {
		"id": { "type": "string" },
		"name": { "type": "string" },
		"email": { "type": "string" }
	}
}
```

No magic. No runtime transformation. The schema object IS the JSON Schema. You can serialize it, store it, send it anywhere.

## Raw JSON Schema In, Validator Out

Here's where TypeBox flexes. The `Compile` function doesn't just accept TypeBox schemas; it accepts any valid JSON Schema object:

```typescript
import { Compile } from 'typebox/compile';

const rawSchema = {
	type: 'object',
	required: ['id', 'name'],
	properties: {
		id: { type: 'number' },
		name: { type: 'string' },
	},
} as const;

const validator = Compile(rawSchema);

validator.Check({ id: 1, name: 'Alice' }); // true
validator.Check({ id: 'x', name: 'Bob' }); // false
```

The `as const` assertion preserves literal types for better TypeScript inference, but isn't required for runtime validation to work.

This means you can take JSON Schema from anywhere: a config file, an API response, a database; run it through `Compile`, and get a working validator.

## Compile vs Value.Check

TypeBox gives you two ways to validate:

**`Compile`** generates optimized validation code. Use it when you'll validate the same schema many times:

```typescript
import { Compile } from 'typebox/compile';

const validator = Compile(schema);

items.forEach((item) => {
	if (validator.Check(item)) {
		process(item);
	}
});
```

**`Value.Check`** validates directly without compilation overhead. Use it for one-off validations:

```typescript
import { Value } from 'typebox/value';

if (Value.Check(schema, singleItem)) {
	process(singleItem);
}
```

Rule of thumb: if you're validating in a loop or the schema lives for the lifetime of your app, use `Compile`. For quick one-time checks, `Value.Check` avoids the upfront cost.

## Why This Matters

Most validation libraries create an abstraction that hides the underlying format. TypeBox does the opposite: the abstraction IS the format. This has real consequences:

1. **Interoperability**: Your schemas work with any JSON Schema tooling
2. **Serialization**: Schemas are plain objects; `JSON.stringify` just works
3. **Portability**: Send schemas over the network, store them in databases
4. **Inspection**: Debug by logging the schema; it's readable JSON

TypeBox treats JSON Schema as a first-class citizen rather than an export target. The TypeScript types are the bonus, not the other way around.
