# ArkType's Hidden Gem: Well-Typed JSON Schema for Draft 2020-12

If you're using ArkType for validation, you might not realize you're also getting a properly typed JSON Schema definition for free.

```typescript
import type { JsonSchema } from 'arktype';
```

That's it. You now have TypeScript types for JSON Schema Draft 2020-12.

## Why This Matters

JSON Schema has gone through many drafts: Draft 04, Draft 06, Draft 07, and finally Draft 2020-12 (the current stable release). Most TypeScript tooling is stuck in the past.

The most popular option, `@types/json-schema` (~40M weekly downloads), only covers up to Draft 07. It hasn't been updated for 2020-12 because the type structure changed significantly enough that it would require breaking changes.

ArkType targets the latest draft by default:

```typescript
schema['~standard'].jsonSchema.input({
	target: 'draft-2020-12', // Latest and greatest
});
```

## It's a Proper Discriminated Union

Unlike flat interface definitions, ArkType's `JsonSchema` namespace gives you discriminated union branches you can actually narrow:

```typescript
import type { JsonSchema } from 'arktype';

// Type-safe narrowing
function processSchema(schema: JsonSchema) {
	if ('anyOf' in schema) {
		// TypeScript knows: schema is JsonSchema.Union
		schema.anyOf.forEach((branch) => processSchema(branch));
	}

	if ('type' in schema && schema.type === 'object') {
		// TypeScript knows: schema is JsonSchema.Object
		Object.entries(schema.properties ?? {}).forEach(([key, prop]) => {
			console.log(`Property ${key}:`, prop);
		});
	}
}
```

The namespace includes all the pieces you'd expect:

- `JsonSchema.String` - string with minLength, maxLength, pattern
- `JsonSchema.Numeric` - number/integer with min, max, multipleOf
- `JsonSchema.Object` - properties, required, additionalProperties
- `JsonSchema.Array` - items, prefixItems, minItems, maxItems
- `JsonSchema.Union` - anyOf composition
- `JsonSchema.OneOf` - oneOf composition
- `JsonSchema.Const` - literal values
- `JsonSchema.Enum` - enumerated values
- `JsonSchema.Ref` - $ref references

## Practical Example

In Epicenter, we convert Standard Schema validators to JSON Schema for MCP tool definitions and CLI generation:

```typescript
import type { JsonSchema } from 'arktype';

function isObjectSchema(
	schema: JsonSchema,
): schema is JsonSchema.Object & { properties: Record<string, JsonSchema> } {
	return 'type' in schema && schema.type === 'object' && 'properties' in schema;
}

function isEnumSchema(schema: JsonSchema): schema is JsonSchema.Enum {
	return 'enum' in schema && schema.enum !== undefined;
}

function isUnionSchema(schema: JsonSchema): schema is JsonSchema.Union {
	return 'anyOf' in schema && schema.anyOf !== undefined;
}

// Now you can introspect schemas programmatically
function schemaToCliOptions(schema: JsonSchema) {
	if (!isObjectSchema(schema)) return;

	for (const [key, fieldSchema] of Object.entries(schema.properties)) {
		if (isEnumSchema(fieldSchema)) {
			// Generate --flag with choices
		} else if (isUnionSchema(fieldSchema)) {
			// Handle union types
		}
		// ...
	}
}
```

## Why Draft 2020-12?

Draft 2020-12 is the current stable JSON Schema specification. It's been stable since December 2020 (hence the name). Key improvements over Draft 07:

- `$defs` replaces `definitions` (cleaner naming)
- `prefixItems` + `items` replaces overloaded `items` for tuples
- `$dynamicRef` for advanced recursive schemas
- Better alignment with OpenAPI 3.1+

If you're building tools that emit or consume JSON Schema (MCP servers, OpenAPI specs, form generators), targeting 2020-12 is future-proof.

## The Takeaway

If you're already using ArkType for validation, you get well-typed JSON Schema definitions as a bonus. No extra dependencies, no separate type packages, no version mismatch headaches.

```typescript
import { type } from 'arktype';
import type { JsonSchema } from 'arktype';

const User = type({
	name: 'string',
	email: 'string.email',
	'age?': 'number >= 0',
});

// Get JSON Schema (Draft 2020-12)
const schema: JsonSchema = User.toJsonSchema();

// Introspect it with full type safety
if ('properties' in schema) {
	console.log(Object.keys(schema.properties)); // ['name', 'email', 'age']
}
```

One less thing to think about.
