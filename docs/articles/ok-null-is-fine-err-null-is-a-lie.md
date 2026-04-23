Never discriminate a `Result` by checking if `data` is null. `Ok(null)` is a perfectly valid value — "the record didn't exist, and that's not an error" is a common pattern. `Err(null)` is a lie — it claims failure with no reason to give. The type system allows both; the semantics don't. Always discriminate by the error side: `isErr(result)` or `result.error !== null`.

In wellcrafted today:

```ts
type Ok<T>  = { data: T; error: null };
type Err<E> = { error: E; data: null };
```

Both variants carry a `null` somewhere. That's the shape the runtime uses to discriminate. And that's where the asymmetry hides.

## The collision

`Ok(null)` and `Err(null)` are structurally identical:

```ts
Ok(null)   // { data: null, error: null }
Err(null)  // { error: null, data: null }
```

Same keys, same values, same shape. No runtime check on their own fields can tell them apart. The built-in `isErr`:

```ts
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.error !== null;
}
```

…returns `false` for `Err(null)`. The `null`-error case is misclassified as success. Empirically confirmed, not theoretical.

## But it works in practice

Because nobody should be calling `Err(null)`. What would it mean? "This failed, here's the reason: nothing." Rust's `Result<T, E>` solves this by forcing `E` to be a meaningful type — if you want "failure without detail" you use `Err(())`, not `Err(null)`. Haskell's `Either` does the same with `Left ()`.

wellcrafted's `Result` doesn't enforce it at the type level. The convention is implicit: pass a real error to `Err`. Every `defineErrors` factory honors this — variants are `{ name, message, ...fields }`, never null. The discriminator works *in practice* because no one violates the convention.

## The rule

Never check `data === null` to mean "this is an error."

```ts
// Wrong. Ok(null) is legal; this passes for success too.
if (result.data === null) { /* handle error */ }

// Right. `null` on the error side is the only discriminator that survives.
if (result.error !== null) { /* handle error */ }

// Also right. The named guard carries intent.
if (isErr(result)) { /* handle error */ }
```

If you ever find yourself writing `"data" in x` or `x.data === null` to distinguish success from failure, stop. The check is symmetric in the wrong direction: `Ok(T)` where `T = null` matches it.

## The logger discriminator that almost got this wrong

While building `wellcrafted/logger`, I needed to distinguish two shapes at runtime:

```ts
type LoggableError = AnyTaggedError | Err<AnyTaggedError>;
```

`AnyTaggedError` is the raw `{ name, message, ...fields }` object. `Err<AnyTaggedError>` is the `{ error: tagged, data: null }` wrapper that `defineErrors` factories return. Both flow into `log.warn(err)`; the logger needs to peel off the wrapper if present.

The first draft used `"data" in err`. That's a presence check, not a null check — but the JSDoc explaining *why it was safe* leaned on "Err has `data: null`". Which is the wrong mental model. `Ok<null>` also has `data: null`. The check happened to work only because `Ok` couldn't reach the function via the type system.

The fix was to pick a discriminator that doesn't flirt with the null semantics at all:

```ts
function unwrapLoggable(err: LoggableError): AnyTaggedError {
  return "name" in err ? err : err.error;
}
```

`name` is always present on a tagged error (stamped by `defineErrors` from the factory key — a hard invariant). It's never present at the top level of `Err<E>` — `Err` has exactly `{ error, data }`. Purely structural. No null-checks anywhere.

## What this means for your code

Wherever you touch a wellcrafted `Result`, check the error side:

```ts
const { data, error } = await tryAsync({ try: ..., catch: ... });
if (error) {
  // handle — error is guaranteed non-null here, by contract
}
use(data);
```

Wherever you discriminate a union that includes an `Err<>` wrapper against another shape, pick an invariant non-null field (like `name`), not a null-valued one.

And if you're ever tempted to write `Err(null)`: you're describing a failure without a reason. Either the failure has a reason — pass it — or what you really have is an `Ok` of nothing.
