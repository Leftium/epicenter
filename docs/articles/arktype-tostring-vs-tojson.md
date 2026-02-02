2025-11-14T09:35:56.389Z

# Understanding toString() vs toJSON(): How JavaScript Decides What to Show

I was staring at a log that said `[object Object]`. Then I tried `JSON.stringify()` and got a 500-line mess. Then I used `.summary` on an ArkType error and got exactly what I needed.

That's when I realized: I didn't actually understand when JavaScript uses `toString()` versus `toJSON()`.

## Here's what actually happens

JavaScript objects can define two methods for serialization:

- `toString()`: Called when the object is coerced to a string
- `toJSON()`: Called when `JSON.stringify()` processes the object

They serve different purposes. And they're called in completely different situations.

## When toString() gets called

String coercion happens in three main situations:

**1. Template literals:**

```typescript
const error = new Error('Something broke');
console.log(`Error: ${error}`);
// Calls error.toString()
```

**2. String concatenation:**

```typescript
const error = new Error('Something broke');
const message = 'Error: ' + error;
// Calls error.toString()
```

**3. Explicit conversion:**

```typescript
const error = new Error('Something broke');
String(error); // Calls error.toString()
```

But here's the catch: most objects have a useless default `toString()`:

```typescript
const user = { name: 'John', age: 30 };
console.log(`User: ${user}`);
// Output: "User: [object Object]"
```

Not helpful.

## When toJSON() gets called

`toJSON()` is only called by one thing: `JSON.stringify()`.

```typescript
const user = {
	name: 'John',
	age: 30,
	toJSON() {
		return { name: this.name }; // Only serialize name
	},
};

JSON.stringify(user);
// Output: '{"name":"John"}'
// age is excluded
```

Notice what didn't call `toJSON()`:

```typescript
console.log(`User: ${user}`); // Still "[object Object]"
```

String coercion ignores `toJSON()` completely. It only calls `toString()`.

## How ArkType uses toString()

ArkType validation errors implement a custom `toString()` that returns the summary:

```typescript
const User = type({
	name: 'string',
	age: 'number',
});

const result = User({ name: 'John', age: 'not a number' });

if (result instanceof type.errors) {
	// These all use toString() internally:
	console.log(`${result}`); // "age must be a number (was string)"
	console.log(String(result)); // "age must be a number (was string)"
	console.log('' + result); // "age must be a number (was string)"

	// This is what's actually being called:
	console.log(result.toString()); // "age must be a number (was string)"

	// Which returns the same as:
	console.log(result.summary); // "age must be a number (was string)"
}
```

That's why `${result}` works. ArkType overrides the default `toString()` to return something useful instead of `[object Object]`.

## What console.log actually does

Here's something that confused me: `console.log()` doesn't use `toString()` or `toJSON()`.

```typescript
const obj = {
	name: 'test',
	toString() {
		return 'Custom toString';
	},
	toJSON() {
		return { custom: 'toJSON' };
	},
};

console.log(obj);
// In Node.js: { name: 'test', toString: [Function], toJSON: [Function] }
// In browser: Shows the actual object with expandable properties
```

`console.log()` uses its own internal formatter. It shows the actual object structure. This is why you see objects nicely formatted in the console, even when they have terrible `toString()` implementations.

But:

```typescript
console.log(`Object: ${obj}`); // "Object: Custom toString"
// Template literal triggers toString()
```

## When to use what

**Use toString() when:**

- You want string coercion to work nicely
- People might use your object in template literals
- You're creating error objects that get logged

**Use toJSON() when:**

- You want to control JSON serialization
- You need to exclude sensitive data from JSON
- You're creating objects that get sent over the wire

**Use both when:**

- Your object needs both human-readable strings AND clean JSON

Example:

```typescript
class User {
	constructor(
		public name: string,
		public email: string,
		private password: string,
	) {}

	toString() {
		return `User(${this.name})`;
	}

	toJSON() {
		return {
			name: this.name,
			email: this.email,
			// password intentionally excluded
		};
	}
}

const user = new User('John', 'john@example.com', 'secret123');

console.log(`Current user: ${user}`);
// "Current user: User(John)"

JSON.stringify(user);
// '{"name":"John","email":"john@example.com"}'
// No password in the JSON
```

## Why JSON.stringify() on errors is bad

When you `JSON.stringify()` an ArkType error, you get everything:

```typescript
if (result instanceof type.errors) {
	console.log(JSON.stringify(result));
	// {"count":2,"summary":"...","message":"...","by":...,"code":...}
	// All the internal properties you don't care about
}
```

If ArkType implemented `toJSON()`, it could control this. But it doesn't need to, because you shouldn't be using `JSON.stringify()` on error objects anyway. You should be using `.summary` or letting `toString()` handle it.

## The mental model

Think of it this way:

- **toString()**: "How should I appear in a sentence?"
- **toJSON()**: "What data should I contribute to a JSON payload?"
- **console.log()**: "Show me the actual object structure"

They're different questions with different answers.

## Real examples from the codebase

**Good use of toString():**

```typescript
// ArkType errors in logs
if (result instanceof type.errors) {
	throw new Error(`Validation failed: ${result}`);
	// Uses toString(), gets clean message
}
```

**Good use of toJSON():**

```typescript
// DateTimeString for API responses
return DateTimeString.stringify(Temporal.Now.zonedDateTimeISO(timezone));
// Returns "2024-01-01T20:00:00.000Z|America/New_York", not a rich object
```

**Bad use of JSON.stringify():**

```typescript
// Don't do this
if (result instanceof type.errors) {
	throw new Error(`Validation failed: ${JSON.stringify(result)}`);
	// Gets messy internal structure
}
```

## Why this matters

I spent time debugging why `${error}` gave me a good message but `JSON.stringify(error)` gave me garbage. Turns out they use completely different methods.

String coercion uses `toString()`. JSON serialization uses `toJSON()`. Console logging uses neither.

Once you know this, the behavior makes sense. Use the right tool for the job:

- Want a log message? Use `toString()` (via `${obj}` or `.summary`)
- Want JSON? Use `JSON.stringify()` (or better, a custom `.toJSON()`)
- Want to inspect an object? Use `console.log(obj)` directly

The lesson: `toString()` and `toJSON()` are different methods for different purposes. Don't use one when you need the other.

For practical examples of logging validation errors, see [Best Practices for Logging ArkType Validation Errors](./arktype-error-logging-best-practices.md).
