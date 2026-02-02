# Clamped Return Pattern

When a function receives input that might be out of range, what should it do? This pattern compares four approaches and explains when "clamp and return" wins.

## The Problem

You have a function that accepts a value, but only certain values are valid:

```typescript
// User wants to set their epoch to 5, but global epoch is only 3
// What should setOwnEpoch(5) do?
```

## Four Options

### Option 1: No-op

Silently ignore invalid input:

```typescript
setOwnEpoch(epoch: number): void {
  if (epoch > getEpoch()) return; // Silent ignore
  epochsMap.set(clientId, epoch);
}

// Usage
head.setOwnEpoch(5); // Does nothing, returns void
head.setOwnEpoch(2); // Works, returns void
// Problem: Caller has no idea what happened
```

**Pros**: Simple, no error handling needed  
**Cons**: Silent failures are dangerous; caller is confused about current state

### Option 2: Throw/Error

Fail explicitly on invalid input:

```typescript
setOwnEpoch(epoch: number): void {
  if (epoch > getEpoch()) {
    throw new Error(`Cannot set epoch ${epoch} higher than global ${getEpoch()}`);
  }
  epochsMap.set(clientId, epoch);
}

// Usage
try {
  head.setOwnEpoch(5);
} catch (e) {
  // Now what? Caller needs to figure out valid range
}
```

**Pros**: Explicit failure, caller must handle  
**Cons**: Requires try/catch, heavy for simple validation, breaks flow

### Option 3: Return Boolean

Return success/failure indicator:

```typescript
setOwnEpoch(epoch: number): boolean {
  if (epoch > getEpoch()) return false;
  epochsMap.set(clientId, epoch);
  return true;
}

// Usage
const success = head.setOwnEpoch(5); // false
if (!success) {
  // OK it failed, but what IS the epoch now?
  // Caller needs a second call to find out
  const actual = head.getOwnEpoch();
}
```

**Pros**: Simple to check  
**Cons**: Caller doesn't know WHAT value was actually used; needs extra call

### Option 4: Clamped Return (Recommended)

Clamp to valid range and return actual value:

```typescript
setOwnEpoch(epoch: number): number {
  const globalEpoch = getEpoch();
  const clampedEpoch = Math.min(epoch, globalEpoch);
  epochsMap.set(clientId, clampedEpoch);
  return clampedEpoch;
}

// Usage
const epoch = head.setOwnEpoch(5); // Returns 3 (clamped)
await workspace.create({ epoch });   // Works with actual value
```

**Pros**: Always succeeds, caller knows exact result, idempotent  
**Cons**: May surprise caller if value differs from input

## When Clamped Return Wins

Use this pattern when:

1. **The operation is idempotent** - calling it multiple times with the same input produces the same result
2. **Any value in the valid range is acceptable** - the caller's intent is "set to something valid"
3. **You want to avoid error handling ceremony** - the caller shouldn't need try/catch for a simple setter
4. **The caller needs the actual result for subsequent operations** - they'll use the returned value immediately

## Real Example: setOwnEpoch

Our epoch system uses clamped return:

```typescript
// Global epoch is 3

// User selects "Epoch 2" from dropdown - valid
const epoch1 = head.setOwnEpoch(2); // Returns 2
const client1 = await workspace.create({ epoch: epoch1 });

// User tries to set higher than global - clamped
const epoch2 = head.setOwnEpoch(5); // Returns 3 (not 5!)
const client2 = await workspace.create({ epoch: epoch2 });

// Caller always gets a usable value, no error handling needed
```

## Key Insight

The clamped return pattern works because of **intent alignment**:

- **Caller's intent**: "Set my epoch to something"
- **Invalid input (5)**: Can't be exactly 5, but 3 is the closest valid value
- **Result**: Caller gets a valid value they can use immediately

It's like CSS `clamp(min, value, max)` - you always get a value in the valid range, guaranteed.

## When NOT to Use This Pattern

Don't use clamped return when:

- **The exact value matters**: If the caller specifically needs epoch 5 and nothing else, they should know it failed
- **Silent changes are dangerous**: If clamping could cause data loss or security issues
- **The valid range is complex**: If it's not a simple min/max, clamping logic gets confusing

In those cases, prefer throwing an error or returning a discriminated union (`{ success: true, value } | { success: false, reason }`).

## Summary

| Pattern        | Best For                                       |
| -------------- | ---------------------------------------------- |
| No-op          | Never (silent failures are dangerous)          |
| Throw/Error    | Critical operations where exact value required |
| Return Boolean | Simple yes/no operations                       |
| Clamped Return | Setters where any valid value is acceptable    |

The clamped return pattern turns "might fail" into "always succeeds with a valid value" - reducing error handling while keeping the caller informed.
