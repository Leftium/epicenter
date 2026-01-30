# Return Object Types for Readable Compile-Time Rejections

**TL;DR**: When rejecting specific string literals at compile time, **return an object type containing your message, not `never`**. TypeScript shows the expected type in errors; if that type contains your message, developers see it.

> The key insight: TypeScript's error says "X is not assignable to type Y". Make Y be your error message.

## The Broken Pattern

The naive approach returns `never` for invalid cases:

```typescript
type ValidFieldId<T extends string> = T extends 'id' ? never : T;

declare function text<const K extends string>(opts: {
	id: ValidFieldId<K>;
}): void;

text({ id: 'id' });
// Error: Type '"id"' is not assignable to type 'never'
```

That error is useless. "Not assignable to never" tells you nothing about why 'id' is forbidden.

## The Fix: Object Error Types

Return an object type that contains your message. Strings can't satisfy object types, so TypeScript shows your message in the error:

```typescript
type SchemaError<Code extends string, Message extends string> = {
	readonly __errorCode: Code;
	readonly __message: Message;
};

type ValidFieldId<K extends string> = K extends 'id'
	? SchemaError<
			'RESERVED_FIELD',
			`"${K}" is reserved - tables have implicit ID`
		>
	: K;

declare function text<const K extends string>(opts: {
	id: ValidFieldId<K>;
}): void;

text({ id: 'id' });
// Error: Type '"id"' is not assignable to type
// 'SchemaError<"RESERVED_FIELD", "\"id\" is reserved - tables have implicit ID">'
```

The error now shows exactly why `'id'` is rejected.

## Why It Works

TypeScript error messages follow the pattern: "Type X is not assignable to type Y".

| Expected Type (Y)            | Error Shows                                               |
| ---------------------------- | --------------------------------------------------------- |
| `never`                      | "not assignable to type 'never'"                          |
| `SchemaError<"CODE", "msg">` | "not assignable to type 'SchemaError<\"CODE\", \"msg\">'" |

The expected type appears verbatim in the error. Put your message there.

## Multiple Error Cases

Handle different invalid patterns with different error codes:

```typescript
type ReservedFields = 'id' | 'createdAt' | 'updatedAt';

type ValidFieldId<K extends string> = K extends ReservedFields
	? SchemaError<'RESERVED', `"${K}" is auto-managed`>
	: K extends `_${string}`
		? SchemaError<'INTERNAL', `"${K}" - underscore prefix is internal`>
		: K extends ''
			? SchemaError<'EMPTY', 'Field ID cannot be empty'>
			: K;

text({ id: '_private' });
// Error: not assignable to type 'SchemaError<"INTERNAL", "\"_private\" - underscore prefix is internal">'
```

## Named Error Types

Make the type name itself descriptive; it appears in the error:

```typescript
type RESERVED_FIELD<Field extends string> = {
	readonly __field: Field;
	readonly __reason: 'is auto-managed by the system';
};

type ValidFieldId<K extends string> = K extends 'id' ? RESERVED_FIELD<K> : K;

text({ id: 'id' });
// Error: not assignable to type 'RESERVED_FIELD<"id">'
```

The type name `RESERVED_FIELD` signals the problem at a glance.

## Comparison

| Approach          | Error Message                                    |
| ----------------- | ------------------------------------------------ |
| Return `never`    | "not assignable to 'never'"                      |
| Object with props | "not assignable to '{ \_\_error: \"message\" }'" |
| Named error type  | "not assignable to 'RESERVED_FIELD<\"id\">'"     |

All object-based approaches show readable messages. Choose based on how much detail you want in the type name vs properties.
