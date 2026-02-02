# Parameter Destructuring over Body Destructuring

In factory functions, we prefer parameter destructuring over body destructuring. While both patterns achieve the same result at runtime, parameter destructuring provides better visibility for developers and more concise code.

## The Problem

AI coding assistants and many developers often default to body destructuring:

```typescript
// Before: Body destructuring (less visible)
function createSomething(opts: Options) {
	const { foo, bar = 'default', baz } = opts; // Extra line of ceremony
	return {
		doWork() {
			console.log(foo, bar, baz);
		},
	};
}
```

This pattern adds an extra line of "ceremony" and hides default values inside the function body.

## The Better Pattern

Inline parameter destructuring is the preferred pattern in this codebase:

```typescript
// After: Parameter destructuring (concise and visible)
function createSomething({ foo, bar = 'default', baz }: Options) {
	return {
		doWork() {
			console.log(foo, bar, baz);
		},
	};
}
```

## Why It's Better

### 1. API Visibility

Defaults are visible at the API boundary. When a developer hovers over the function name in their IDE, they see the destructured parameters and their default values directly in the signature. This makes the function's contract self-documenting.

### 2. Concise Implementation

It removes one line of boilerplate. In factory functions where the first argument is almost always a configuration or dependency object, destructuring in the signature is cleaner.

### 3. Closure Capture

Closures capture the variables either way. Since factory functions typically return an object with methods that reference these parameters, parameter destructuring ensures those variables are available in the closure scope without any additional overhead.

### 4. TypeScript Literal Inference

Parameter destructuring works correctly with TypeScript's `const` generic type parameters. If you use a `const` modifier on a generic type to infer literal types, destructuring in the signature allows TypeScript to maintain that precision more effectively than destructuring an opaque `opts` object later.

## When Body Destructuring is Still Valid

Parameter destructuring is the default, but body destructuring is appropriate in specific scenarios:

- **Presence Checks**: When you need to distinguish between a key being `undefined` and a key being missing entirely using the `'key' in opts` check.
- **Complex Normalization**: When parameters require significant validation or transformation before they can be used by the returned object.
- **Passing the Whole Object**: When you need to pass the original `opts` object as a single unit to other helper functions.

## Real Codebase Examples

The Epicenter codebase follows this pattern consistently for its factory functions:

### Key Recorder

From `create-key-recorder.svelte.ts`:

```typescript
export function createKeyRecorder({
	pressedKeys,
	onRegister,
	onClear,
}: {
	pressedKeys: PressedKeys;
	onRegister: (keyCombination: KeyboardEventSupportedKey[]) => void;
	onClear: () => void;
}) {
	// ... implementation
}
```

### Deepgram Transcription Service

From `deepgram.ts`:

```typescript
export function createDeepgramTranscriptionService({
	HttpService,
}: {
	HttpService: HttpService;
}) {
	// ... implementation
}
```

### Select Component Helper

From `typescript-const-modifier-generic-type-parameters.md`:

```typescript
function select({
	options,
	nullable = false,
	default: defaultValue,
}: {
	options: readonly string[];
	nullable?: boolean;
	default?: string;
}) {
	// ... implementation
}
```
