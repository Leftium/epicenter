# One Happy Path, Many Error Paths: Nest, Don't Flatten

Most operations have one success case and several failure cases. The flat discriminated union puts them all at the same level, which is a lie about the shape of the problem. The better structure is an unbalanced binary tree: split success from failure first, then discriminate the failure cases on a second key.

```
Flat (every case is a peer):          Nested (success is special):

      ┌────────┐                          ┌──────────────┐
      │ status │                          │ data , error │
      └───┬────┘                          └──────┬───────┘
          │                                      │
   ┌──────┼──────┬──────┐            ┌───────────┴───────────┐
   │      │      │      │            │                       │
  ok    404    422    500        data: T                 data: null
                                error: null              error: E
                                     │                       │
                                  (done)              ┌──────┼──────┐
                                                      │      │      │
                                                     404    422    500
```

The left tree has four peer cases. The right tree splits on a symmetric pair first: `data` and `error` are both present, but one is always `null`. Check which side you're on, then the error branch fans out by status. The right tree matches how you actually think about the result.

## Flat unions force you to handle success like it's one of many problems

Here's the flat version. Every outcome competes for attention at the same level:

```typescript
type Result =
  | { status: 'ok'; data: Note }
  | { status: 'not_found'; id: string }
  | { status: 'validation_error'; errors: ValidationError[] }
  | { status: 'server_error'; detail: string };
```

The consumer writes a switch with four cases, and the happy path sits between error handlers:

```typescript
switch (result.status) {
  case 'ok':
    renderNote(result.data);
    break;
  case 'not_found':
    show404(result.id);
    break;
  case 'validation_error':
    showErrors(result.errors);
    break;
  case 'server_error':
    reportCrash(result.detail);
    break;
}
```

Every call site repeats this full switch. There's no way to say "handle the happy path, then deal with errors generically" because success and failure are at the same level.

## Nested discrimination separates the question you always ask first

The nested version splits on the question you actually ask: did it work?

```typescript
// First level: did it work?
type Result<T> =
  | { data: T; error: null }
  | { data: null; error: TypedError };

// Second level: what went wrong?
type TypedError =
  | { status: 404; value: { id: string } }
  | { status: 422; value: { errors: ValidationError[] } }
  | { status: 500; value: { detail: string } };
```

Now the consumer handles success first, errors second:

```typescript
const { data, error } = await getNote(id);

if (error) {
  // All error handling lives here
  switch (error.status) {
    case 422:
      showErrors(error.value.errors);
      break;
    default:
      showGenericError(error.status);
  }
  return;
}

// Past this point, data is narrowed to Note
renderNote(data);
```

The happy path falls through cleanly. Error handling is namespaced under the `if (error)` branch. You can handle all errors generically with a single `default` case, or drill into specific ones. With the flat union, you can't do that without listing every non-ok case.

## Eden does this at the HTTP boundary

Elysia's Eden Treaty client implements exactly this pattern. The server defines per-status-code response schemas:

```typescript
router.post(
  '/notes/create',
  async ({ body, status }) => {
    if (!Value.Check(NoteInput, body))
      return status('Unprocessable Content', {
        errors: Value.Errors(NoteInput, body),
      });
    return { data: await createNote(body) };
  },
);
```

Eden returns `{ data, error }` where `data` and `error` are the first discriminator (one is always `null`). Then `error.status` is the second discriminator that narrows `error.value` to the exact body shape for that status code. Two levels, both inferred from the server definition.

```typescript
const { data, error } = await api.notes.create.post({ title: 'Hello' });

if (error) {
  // error.status: 422 | 401 | 500
  // error.value narrows per status
  return;
}

// data: { data: Note }
```

This isn't an Eden-specific trick. It's the same unbalanced tree: binary split first, then fan out the error branch.

## The pattern works because success and failure aren't peers

A flat union says "here are four equally likely outcomes, handle them all." A nested union says "here's what you wanted, and here's what might go wrong." That matches the actual shape: there's one way for an operation to succeed and several ways for it to fail. The type system should reflect that asymmetry, not flatten it.

| Flat union | Nested union |
| --- | --- |
| Success is case 1 of N | Success is the default path |
| Every call site writes full switch | Call sites handle errors in one branch |
| Can't handle errors generically | `default` case covers all errors |
| Happy path buried in switch | Happy path falls through after guard |

Flat discriminated unions are right when all cases genuinely are peers: a command queue where `closeTabs` and `openTab` are equally valid actions, or a config where `open` and `static-token` are equally valid modes. When one case is the happy path and the rest are error variants, nest them.
