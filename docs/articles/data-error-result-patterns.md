# Data & Error Patterns: Three Approaches

This codebase uses three distinct patterns for handling success/failure states. Each has its place depending on how many failure modes exist and whether they need equal treatment.

## Pattern 1: Binary Result (Wellcrafted)

The simplest pattern. Two states: success or failure.

```
                    ┌─────────────┐
                    │   Result    │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
        ┌─────▼─────┐             ┌─────▼─────┐
        │   data    │             │   error   │
        │  (value)  │             │ (tagged)  │
        └───────────┘             └───────────┘
```

**When to use**: Binary outcomes. It worked or it didn't.

```typescript
import { tryAsync, Ok, Err } from 'wellcrafted/result';

const { data, error } = await tryAsync({
	try: () => fetchUser(id),
	catch: (e) => UserServiceErr({ message: 'Failed to fetch user', cause: e }),
});

if (error) return Err(error);
return Ok(data);
```

**Examples in codebase**:

- All service layer functions (`transcribe`, `complete`, `clipboard.setClipboardText`)
- HTTP requests, file operations, API calls

---

## Pattern 2: Discriminated Union (Flat)

Multiple states at the same level. Each state is "equal" with its own metadata.

```
                    ┌─────────────┐
                    │   status    │  ← discriminator key
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
   ┌─────▼─────┐     ┌─────▼─────┐     ┌─────▼─────┐
   │  'valid'  │     │ 'invalid' │     │'not_found'│
   │           │     │           │     │           │
   │ + row     │     │ + id      │     │ + id      │
   └───────────┘     │ + error   │     └───────────┘
                     └───────────┘
```

**When to use**: Multiple distinct outcomes that aren't hierarchical. Each case needs different handling.

```typescript
// From table-helper.ts
export type GetResult<TRow> =
	| { status: 'valid'; row: TRow }
	| { status: 'invalid'; id: string; error: RowValidationError }
	| { status: 'not_found'; id: string };

// Usage
const result = tables.posts.get(id);
switch (result.status) {
	case 'valid':
		console.log('Row:', result.row);
		break;
	case 'invalid':
		console.error('Validation failed:', result.error.context.summary);
		break;
	case 'not_found':
		console.log('Not found:', result.id);
		break;
}
```

**More examples from codebase**:

```typescript
// UpdateResult - two states, different semantics
export type UpdateResult =
	| { status: 'applied' }
	| { status: 'not_found_locally' };

// UpdateManyResult - three states with varying metadata
export type UpdateManyResult =
	| { status: 'all_applied'; applied: string[] }
	| {
			status: 'partially_applied';
			applied: string[];
			notFoundLocally: string[];
	  }
	| { status: 'none_applied'; notFoundLocally: string[] };

// KV validation - similar pattern
type KvGetResult<TValue> =
	| { status: 'valid'; value: TValue }
	| { status: 'invalid'; key: string; error: KvValidationError };
```

---

## Pattern 3: Nested Error Variants (withContext)

Binary at top level, but error can have multiple variants via `.withContext()`.

```
                    ┌─────────────┐
                    │   Result    │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
        ┌─────▼─────┐             ┌─────▼─────┐
        │   data    │             │   error   │
        │  (value)  │             └─────┬─────┘
        └───────────┘                   │
                           ┌────────────┼────────────┐
                           │            │            │
                     ┌─────▼────┐ ┌─────▼────┐ ┌─────▼────┐
                     │Connection│ │ Response │ │  Parse   │
                     │  Error   │ │  Error   │ │  Error   │
                     └──────────┘ │          │ └──────────┘
                                  │ +status  │
                                  └──────────┘
```

**When to use**: Binary success/failure, but failures have multiple causes with different context needs.

```typescript
// From http/types.ts - Error hierarchy with context
export const { ConnectionError, ConnectionErr } =
	createTaggedError('ConnectionError');

export const { ResponseError, ResponseErr } = createTaggedError(
	'ResponseError',
).withContext<{ status: number }>(); // ← nested context!

export const { ParseError, ParseErr } = createTaggedError('ParseError');

// Union type for all HTTP errors
export type HttpServiceError = ConnectionError | ResponseError | ParseError;

// Usage - still binary at top level
const { data, error } = await httpService.post({ url, body, schema });

if (error) {
	// Can narrow by error tag
	if (error._tag === 'ResponseError') {
		console.log('HTTP status:', error.context.status); // type-safe access
	}
	return Err(error);
}
```

**Another example** - Row validation errors with rich context:

```typescript
// Error with nested context
export const { RowValidationError, RowValidationErr } = createTaggedError(
	'RowValidationError',
).withContext<{
	tableName: string;
	id: string;
	errors: ArkErrors;
	summary: string;
}>();

// Usage in table-helper.ts
return {
	status: 'invalid',
	id,
	error: RowValidationError({
		message: `Row '${id}' in table '${tableName}' failed validation`,
		context: {
			tableName,
			id,
			errors: result,
			summary: result.summary,
		},
	}),
};
```

---

## Choosing the Right Pattern

| Scenario                                | Pattern               | Example                                        |
| --------------------------------------- | --------------------- | ---------------------------------------------- |
| Simple success/failure                  | Binary Result         | API calls, file I/O                            |
| Multiple distinct outcomes, all "equal" | Discriminated Union   | `GetResult` (valid/invalid/not_found)          |
| Binary outcome, but failures vary       | Nested Error Variants | `HttpServiceError` (connection/response/parse) |
| CRUD operations with partial success    | Discriminated Union   | `UpdateManyResult` (all/partial/none applied)  |

## The Key Insight

**Discriminated unions** put all cases at the same level—they're "peers". Use when:

- Cases need fundamentally different handling
- No natural hierarchy (is "not found" really an "error"?)

**Nested error variants** maintain binary success/failure but add structure to the failure case. Use when:

- Success is clearly "the good case"
- Failures are variations of "something went wrong"
- You want to narrow error types later
