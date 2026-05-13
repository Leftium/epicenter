# Two Functions for One Slot Is a Test Driving Your API

You're looking at a helper that takes a `getPayload` and a `setPayload`. Same shape, same state, two parameters. The caller passes a closure for each, both pointing at the same variable. Nothing in the type system says the getter reads what the setter wrote. The convention is just understood.

That's a test in disguise.

## The Smell

This was real code in `@epicenter/svelte` last week:

```ts
export function createSessionLifecycle<T extends Disposable>({
    auth,
    build,
    getPayload,
    setPayload,
}: {
    auth: AuthClient;
    build: (identity: WorkspaceIdentity) => T;
    getPayload: () => T | null;
    setPayload: (payload: T | null) => void;
}) {
    function reconcile(state: AuthState) {
        const payload = getPayload();
        if (state.status === 'signed-out') {
            if (payload) { payload[Symbol.dispose](); setPayload(null); }
            return;
        }
        if (!payload) setPayload(build(state.identity));
    }
    const unsubscribe = auth.onStateChange(reconcile);
    reconcile(auth.state);
    return { [Symbol.dispose]() { unsubscribe(); getPayload()?.[Symbol.dispose](); setPayload(null); } };
}
```

The only consumer:

```ts
let payload = $state<T | null>(null);
const lifecycle = createSessionLifecycle<T>({
    auth, build,
    getPayload: () => payload,
    setPayload: (next) => { payload = next; },
});
```

Five lines of branch logic. Forty-seven of helper. Eighteen of plumbing at the call site. Why?

## Trace It Back

Read the test file. Look at every `expect()` and ask: what is this assertion forcing the design to allow?

The test had four cases:

```ts
test('signed-in -> reauth -> signed-in preserves payload', () => { ... });
test('signed-out disposes payload', () => { ... });
test('cold boot in reauth-required builds payload', () => { ... });
test('lifecycle disposal disposes payload', () => { ... });
```

To make those assertable, the test needed to *see* the payload slot. To see the slot, the helper had to *take* the slot. To take the slot, the helper needed two functions: one to read, one to write.

The test wrote the API.

That's the move: trace from `expect()` back through the parameter list, and notice that the parameter exists only because the test couldn't otherwise reach the value.

## Price the Test Honestly

Then count lines.

| File | LOC |
|---|---|
| `session-lifecycle.ts` (helper) | 47 |
| `session-lifecycle.test.ts` (test) | 187 |
| `session.svelte.ts` (call site) | 69 |

The test was **ten times** the size of the helper's branch logic. The test was the largest artifact in the system. The injection ceremony existed to feed the test.

When the test is the largest artifact, the test is the design. That's fine for libraries with stable consumers. For internal helpers with one call site, it's a tail wagging a dog.

## Collapse

The reactivity could just live in the same file as its sole consumer. Move it into the `.svelte.ts` file. Let `$state` own the slot directly. No getter, no setter, no holder type, no test fake.

```ts
export function createSession<T extends Disposable>({ auth, build }: { ... }) {
    let payload = $state<T | null>(null);

    function reconcile(state: AuthState) {
        if (state.status === 'signed-out') {
            payload?.[Symbol.dispose]();
            payload = null;
        } else {
            payload ??= build(state.identity);
        }
    }
    const unsubscribe = auth.onStateChange(reconcile);
    reconcile(auth.state);
    // ... `current`, `require`, `Symbol.dispose`
}
```

The state machine is now three lines in plain sight. `payload ??= build(state.identity)` is the reauth-preservation invariant; it's a single operator, hard to break without intent. `T extends Disposable` enforces the dispose call site at the type level. The four test cases that justified the split are now visible from one read.

Net: minus 265 lines, three files to one, two injection points to zero.

## The General Rule

Dependency injection earns its keep when it carries **policy** or crosses a **boundary**. It is a smell when it carries **state**.

**Policy injection** is fine. Same file, post-collapse:

```ts
onDifferentUser: () => {
    location.reload();
    throw new Error('unreachable: reload pending');
},
```

That callback is a decision the framework can't make: what to do when the user switches. Reload? Toast? Navigate? The caller owns the policy; the helper invokes it. The injection carries semantics.

**Boundary injection** is fine. From `epicenter ps`:

```ts
export type RunPsDeps = {
    pingDaemon?: (socketPath: string, timeoutMs?: number) => Promise<boolean>;
};
```

`pingDaemon` opens a Unix socket. Tests can't realistically stand up a daemon just to verify the dead-pid sweep, so the seam isolates the I/O boundary. The injection lets tests run without touching the OS.

**State injection** is the smell. `getPayload`/`setPayload` carry no semantics. They aren't a policy choice; they aren't a boundary. They are *the same variable*, twice. The only reason to split a variable across two functions is so someone else (the test) can own it.

## How to Spot It

A few signals, in order of strength:

1. **Two parameters describe one slot.** `getX` + `setX`, `getState` + `setState`, `current` + `update`. Same value, two halves.
2. **The production call site closes over a single `let`** and passes its read/write through. Every caller would write the same two closures.
3. **The test file is multiples the size of the helper** and the test contains a `makeHolder()` or `setupSlot()` helper that reconstructs production state inside the test.
4. **The helper has exactly one production consumer**, and that consumer lives next door.
5. **The helper would compile as inline code in its consumer**, with no loss of meaning.

Hit two or more and the helper exists for the test.

## When to Keep the Split

Inlining isn't always right. Keep the split when:

- The helper has multiple real consumers and the seam earns a stable contract.
- The injected thing carries policy (a decision the caller owns) or crosses a runtime boundary (sockets, signals, filesystem, network).
- The state being passed in genuinely *originates* outside the helper (a shared cache, a global registry).
- The test exercises behavior end-to-end against the seam's other side (real auth flows, real workspace operations).

The question isn't "can I inline this." The question is "what does the parameter list say about who owns the value." If the parameter list says the test owns it, the parameter list is wrong.

## The Move

When you next see a helper with a getter and a setter for the same value, do this:

1. Open the test. Read each `expect()`.
2. Ask which parameter exists only so the test could write that `expect()`.
3. Count lines: helper, test, call site.
4. If the test is the largest artifact and its assertions all observe internal state, the helper is test-shaped, not code-shaped.
5. Inline. Type the invariant. Let the next reader see the state machine in plain sight.

The test is a hypothesis about what the code should let you observe. When the hypothesis warps the production API into something nobody else would have written, the hypothesis is wrong. Delete it; the asymmetric win is real.
