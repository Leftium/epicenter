# TypeBox: Compile Any JSON Schema Object

If you have a JSON Schema as a plain JavaScript object and you want a validator, TypeBox does exactly this. No setup, no configuration, no ceremony.

## The Simplest Case

```typescript
import { Compile } from 'typebox/compile';

const schema = {
	type: 'object',
	required: ['name', 'age'],
	properties: {
		name: { type: 'string' },
		age: { type: 'number', minimum: 0 },
	},
} as const;

const validator = Compile(schema);

validator.Check({ name: 'Alice', age: 30 }); // true
validator.Check({ name: 'Bob', age: -5 }); // false (age below minimum)
validator.Check({ name: 'Charlie' }); // false (missing age)
```

That's it. Pass a JSON Schema object to `Compile`, get a validator back.

## Where the Schema Comes From Doesn't Matter

The schema can come from anywhere:

```typescript
// From a config file
const schema = JSON.parse(fs.readFileSync('schema.json', 'utf-8'));
const validator = Compile(schema);

// From an API response
const response = await fetch('/api/schema');
const schema = await response.json();
const validator = Compile(schema);

// From a database
const schema = await db.query('SELECT schema FROM schemas WHERE name = ?', [
	'user',
]);
const validator = Compile(schema);

// From another device over WebSocket/HTTP
const schema = JSON.parse(message.data);
const validator = Compile(schema);

// Hardcoded in your code
const schema = { type: 'string', minLength: 1 } as const;
const validator = Compile(schema);
```

For more on sending schemas across the network, see [JSON Schema Over the Wire](./typebox-json-schema-over-the-wire.md).

## Getting Errors

```typescript
const validator = Compile(schema);

if (!validator.Check(data)) {
	const errors = [...validator.Errors(data)];
	errors.forEach((err) => {
		console.log(`${err.path}: ${err.message}`);
	});
}
```

## When to Use This

Use TypeBox when:

- You have JSON Schema from an external source
- You're receiving schema definitions at runtime
- You want to validate without defining types twice
- You need a validator from a plain object, no questions asked

TypeBox doesn't care how you got the schema. Hand it a valid JSON Schema object, it gives you a validator. Simple as that.
