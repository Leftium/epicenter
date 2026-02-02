# YKeyValue Dual Implementation Strategy

**Date**: 2026-01-27
**Status**: APPROVED

## Summary

We maintain two YKeyValue implementations with different conflict resolution strategies:

| Implementation | File | Conflict Resolution | Use Case |
|----------------|------|---------------------|----------|
| `YKeyValue` | `y-keyvalue.ts` | Positional (rightmost wins) | Real-time collab, simple cases |
| `YKeyValueLww` | `y-keyvalue-lww.ts` | Timestamp-based (last-write-wins) | Offline-first, multi-device |

## Rationale

### Why Two Implementations?

1. **Different trade-offs**: Positional is simpler and has no clock dependencies. LWW is more intuitive for offline editing but assumes reasonable clock sync.

2. **Migration path**: Existing code using `YKeyValue` continues to work. New code can opt into `YKeyValueLww` where timestamp semantics matter.

3. **Minimal overhead**: The LWW version adds only ~8 bytes per entry (timestamp field).

### When to Use Each

**Use `YKeyValue` (positional) when:**
- Real-time collaboration where conflicts are resolved immediately
- Clock synchronization cannot be assumed
- You want the simplest possible implementation
- You're okay with "deterministic but arbitrary" conflict resolution

**Use `YKeyValueLww` (timestamp) when:**
- Offline-first editing across multiple devices
- Users expect "my latest edit should win"
- Devices have reasonably synchronized clocks (NTP)
- You need debugging visibility into "who won and why"

## Implementation Differences

### Entry Format

```typescript
// YKeyValue (positional)
type Entry<T> = { key: string; val: T };

// YKeyValueLww (timestamp)
type Entry<T> = { key: string; val: T; ts: number };
```

### Conflict Resolution

```typescript
// YKeyValue: Rightmost entry wins after Yjs CRDT merge
// The "rightmost" position is determined by Yjs's internal clientID ordering

// YKeyValueLww: Higher timestamp wins
// Tiebreaker: positional (rightmost wins) when timestamps equal
function shouldReplace(existing: Entry, incoming: Entry): boolean {
  return incoming.ts > existing.ts;  // If equal, fall back to positional
}
```

### Timestamp Generation

```typescript
// YKeyValueLww uses a monotonic clock to prevent same-millisecond collisions
private lastTs = 0;
private getTimestamp(): number {
  const now = Date.now();
  this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
  return this.lastTs;
}
```

## Migration

### From YKeyValue to YKeyValueLww

The two implementations use different entry formats:
- `YKeyValue`: `{ key, val }`
- `YKeyValueLww`: `{ key, val, ts }`

When migrating data from `YKeyValue` to `YKeyValueLww`, existing entries must be re-written with timestamps. All `YKeyValueLww` entries are required to have the `ts` field.

### Switching Back

If you switch from LWW back to positional, the `ts` field is simply ignored. No data loss, but conflict resolution reverts to positional semantics.

## API Compatibility

Both implementations expose the same public API:

```typescript
interface YKeyValueAPI<T> {
  get(key: string): T | undefined;
  has(key: string): boolean;
  set(key: string, val: T): void;
  delete(key: string): void;
  on(event: 'change', handler: ChangeHandler<T>): void;
  off(event: 'change', handler: ChangeHandler<T>): void;
  readonly map: Map<string, Entry<T>>;
  readonly yarray: Y.Array<Entry<T>>;
  readonly doc: Y.Doc;
}
```

Code can switch between implementations by changing the import:

```typescript
// Before
import { YKeyValue } from './y-keyvalue';

// After
import { YKeyValueLww as YKeyValue } from './y-keyvalue-lww';
```

## Related Specs

- `20260107T020000-ykeyvalue-lww-timestamps.md` - Original LWW design (detailed implementation notes)
- `20260107T010300-ykeyvalue-conflict-resolution-analysis.md` - Analysis of conflict resolution behavior
- `20260108T084500-ymap-native-storage-architecture.md` - Decision to defer LWW (now revisited)

## Files

- `packages/epicenter/src/core/utils/y-keyvalue.ts` - Positional implementation
- `packages/epicenter/src/core/utils/y-keyvalue-lww.ts` - LWW implementation
- `packages/epicenter/src/core/utils/y-keyvalue.test.ts` - Tests for positional
- `packages/epicenter/src/core/utils/y-keyvalue-lww.test.ts` - Tests for LWW
