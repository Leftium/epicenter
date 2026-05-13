---
name: inject-policy-not-state
description: "Detect and collapse dependency injection that exists only so a test can own a production state slot. Use when reviewing a helper paired with a test file, when a function takes `getX`/`setX` for the same value, when a test file is significantly larger than the helper it tests, or when the user says \"trace this test\", \"inline this helper\", \"why does this take a getter and a setter\", \"the test is driving the API\", \"is this seam earning its keep\". Distinguishes state injection (smell) from policy and boundary injection (legitimate)."
metadata:
  author: epicenter
  version: '1.0'
---

# Inject Policy, Not State

Dependency injection earns its keep when it carries **policy** (a decision the
caller owns) or crosses a **runtime boundary** (sockets, signals, filesystem,
network). It is a smell when it carries **state** the production code already
owns and the only consumer of the seam is a test.

Related skills: [cohesive-clean-breaks](../cohesive-clean-breaks/SKILL.md) owns
the asymmetric-wins decision once you find a candidate, [refactoring](../refactoring/SKILL.md)
for caller counting and inlining mechanics, [radical-options](../radical-options/SKILL.md)
when the helper is honoring a bad shape, [testing](../testing/SKILL.md) for what
the post-collapse tests should look like.

## When to Apply

Trigger when you see any of these signals together:

- A helper takes two parameters for the same value (`getX` + `setX`, `getState`
  + `setState`, `current` + `update`).
- Every production caller passes closures over the same `let`.
- A `.test.ts` file is more than 3x larger than the helper it tests (raw LOC).
- The test contains a `makeHolder()`, `setupSlot()`, or fake builder that
  reconstructs production state.
- The helper has exactly one production consumer in the same package.
- The injected parameter has no semantics; it is a variable wearing two coats.

Hit two or more and the helper is test-shaped, not code-shaped.

User phrases that should trigger this skill: "trace this test", "is this seam
earning its keep", "the test is driving the API", "why does this take a getter
and a setter", "inline this helper", "the test is bigger than the code".

## The Three Kinds of DI

Before recommending a collapse, classify what the injection is carrying.

### 1. State injection (SMELL)

```ts
// helper.ts
export function reconcileSomething({
    getValue,
    setValue,
}: {
    getValue: () => T | null;
    setValue: (next: T | null) => void;
}) { ... }

// caller.ts
let value = $state<T | null>(null);
reconcileSomething({
    getValue: () => value,
    setValue: (next) => { value = next; },
});
```

The two functions describe one slot. Nothing in the type system says the
getter reads what the setter wrote. The only reason to split a variable into
two functions is so the test can own it. **Inline.**

### 2. Policy injection (FINE)

```ts
onDifferentUser: () => {
    location.reload();
    throw new Error('unreachable: reload pending');
},
reportError: (err) => toast.error(err.message),
```

The callback encodes a decision the helper cannot make: reload? toast?
navigate? The caller owns the policy; the helper invokes it at the right
lifecycle moment. The injection carries **semantics**. Keep.

### 3. Boundary injection (FINE)

```ts
export type RunPsDeps = {
    pingDaemon?: (socketPath: string, timeoutMs?: number) => Promise<boolean>;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
};
```

The injected function opens a socket, signals a pid, hits the network, writes
a file. Tests can't realistically run the real boundary, so the seam lets
production use the real I/O while tests substitute a fake. The injection
isolates a **runtime boundary**. Keep.

## The Procedure

When you find a state-injection candidate:

1. **Open the test file.** Read every `expect()`.
2. **Trace each assertion back through the parameter list.** Which parameter
   exists only so the test could write that `expect()`?
3. **Count lines:** helper LOC, test LOC, call site LOC. If the test is the
   largest artifact AND every assertion observes internal state, the helper
   is test-shaped.
4. **Mentally inline** the helper into its sole consumer. If the result reads
   naturally and the invariants are still visible in the type system or the
   collapsed branch logic, the split was the test's idea.
5. **Decide the test's fate:**
    - If the inlined branch logic is small (under ~10 lines) and exercised
      end-to-end by every app boot, **delete the test**. Its regression
      insurance is no longer worth the seam tax.
    - If the branch logic is non-trivial, **extract a pure reducer** (no DI,
      no slot) and test that. The helper itself stays inlined.
6. **Verify** with typecheck + every call site grep before deleting files.

## Worked Example

From `@epicenter/svelte`, commit `d5b61aed8`:

- Before: 3 files, 303 LOC across `session-lifecycle.ts` (47), `session-lifecycle.test.ts` (187), `session.svelte.ts` (69).
- DI seam: `getPayload`/`setPayload` describing one `$state` slot.
- After: 1 file, ~38 LOC. `$state` lives inline. Test deleted.
- Net: minus 265 LOC, 2 exports to 1, 2 injection points to 0.

Article: [Two Functions for One Slot Is a Test Driving Your API](../../docs/articles/20260513T120000-two-functions-one-slot-is-a-test-driving-your-api.md).

## What This Skill Will NOT Recommend

- **Boundary injection** for sockets, signals, filesystem, network. Even if the
  test is larger than the SUT, the seam isolates real I/O.
- **Policy injection** carrying callbacks that name lifecycle moments (`onError`,
  `onCleanup`, `onDifferentUser`, `reportError`). The injection is the API
  contract.
- **Helpers with multiple real consumers.** A seam shared by three callers earns
  its stability tax.
- **Cross-package helpers** where the test crosses a runtime the source can't
  reach (Bun runtime testing browser code, Node test driving Tauri).

When in doubt, classify the injection first. If it has semantics, it's policy.
If it touches the OS or network, it's a boundary. If it's two halves of a
variable, it's state — and the test wrote the API.

## Quick Audit Grep

For sweeping a codebase:

```sh
# Find paired getter/setter parameters in TS source.
grep -rEn 'get[A-Z][a-zA-Z]+\?:.*\bset[A-Z][a-zA-Z]+\?:' packages/ apps/

# Find test files >3x the size of their SUT.
for t in $(find packages apps -name '*.test.ts' -not -path '*/node_modules/*'); do
    s="${t%.test.ts}.ts"
    [ -f "$s" ] || continue
    tl=$(wc -l < "$t"); sl=$(wc -l < "$s")
    [ "$sl" -lt 1 ] && continue
    ratio=$(( tl * 10 / sl ))
    [ "$ratio" -ge 30 ] && echo "$t ($tl) vs $s ($sl) ratio=${ratio}/10"
done
```

The grep finds DI shape; the LOC ratio finds the test-tail-wagging-the-dog
signal. Run both. Investigate the intersection.
