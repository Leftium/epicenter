# Eden Gives You Two Discriminators for Free

Elysia's Eden Treaty client returns `{ data, error }` where one is always `null`. That's your first discriminator (symmetric discriminant, where either `data` or `error` is the discriminant key). The second is `error.status`, which narrows the error body to the exact shape you declared for that status code. Two levels of narrowing, zero runtime overhead, all inferred from the server definition.

```
Eden Response
    │
    ├── data: { data: T }          ← success (2xx)
    │   error: null
    │
    └── data: null
        error ─┬── .status: 422   ← narrows to { errors: [...] }
               ├── .status: 401   ← narrows to { message: string }
               └── .status: 500   ← narrows to { detail: string }
```

## The server defines the contract, Eden infers it

Here's an action route that validates input with TypeBox and returns per-status-code responses:

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
  {
    detail: { summary: 'notes.create', tags: ['mutation'] },
  },
);
```

`status('Unprocessable Content', { errors: [...] })` tells Elysia two things: the HTTP status code is 422, and the body shape for that code is `{ errors: TLocalizedValidationError[] }`. Eden picks up both.

## First discriminator: `data` vs `error`

On the client, every Eden call returns the same wrapper:

```typescript
const { data, error } = await api.actions.notes.create.post({
  title: 'Hello',
  content: '',
});

if (error) {
  // data is null, error is typed
  console.log(error.status, error.value);
  return;
}

// error is null, data is typed
console.log(data.data); // the Note object
```

This is the same shape as a `Result` type. Check `error`, handle it, and the rest of the function has `data` narrowed to the success type. Nothing new here.

## Second discriminator: `error.status` narrows the body

The interesting part is what happens inside the error branch. If the server defines multiple error status codes, `error.status` becomes a literal union and `error.value` narrows when you switch on it:

```typescript
if (error) {
  switch (error.status) {
    case 422:
      // error.value: { errors: TLocalizedValidationError[] }
      for (const e of error.value.errors) {
        console.log(e.path, e.message);
      }
      break;
    case 401:
      // error.value: { message: string }
      redirect('/login');
      break;
    case 500:
      // error.value: { detail: string }
      reportCrash(error.value.detail);
      break;
  }
}
```

Each `case` gives you a different type for `error.value`. TypeScript narrows it automatically because `error.status` is a literal discriminator, not just `number`.

```
                     ┌──────────────┐
                     │  if (error)  │  ← first narrowing
                     └──────┬───────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
    case 422          case 401          case 500
          │                 │                 │
   { errors: [...] }  { message }      { detail }
                                                    ← second narrowing
```

## This replaces wrapper envelopes

Without per-status-code schemas, you'd need a single response envelope with optional fields:

```typescript
type Response<T> = {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
  message?: string;
};
```

Every consumer has to check `success`, then guess which optional fields are populated. Eden makes this unnecessary. The HTTP status code already discriminates the shape, and Eden threads that discrimination through to the TypeScript types. Your response bodies stay clean: `{ data: T }` for success, `{ errors: [...] }` for validation failure. No wrapper, no `success` flag, no optional fields.

The server just returns the right status code with the right body. Eden does the rest.
