# Why I Use DateTimeString as Intermediate Representation

> See [PR #1216](https://github.com/EpicenterHQ/epicenter/pull/1216) for the full context on this pattern.

Instead of eagerly parsing dates into rich objects at every boundary, I keep them as `DateTimeString` throughout the system and parse to `Temporal.ZonedDateTime` only at the moment they're needed (typically UI binding).

## The Problem

The old `DateWithTimezone` type created unnecessary churn:

```
SQLite (string) → parse → DateWithTimezone → serialize → API response (string) → parse → frontend → serialize → ...
```

Every boundary triggered parse/serialize cycles. The rich datetime object was only meaningful for brief moments (date pickers, date math), yet I paid the conversion cost everywhere.

## The Solution

Use `DateTimeString` (a branded string) as the canonical intermediate representation:

```typescript
// Storage format unchanged: "2024-01-01T20:00:00.000Z|America/New_York"
type DateTimeString = `${DateIsoString}|${TimezoneId}` & Brand<'DateTimeString'>;

// Companion object with JSON-style API
const DateTimeString = {
  parse(str: DateTimeString): Temporal.ZonedDateTime,  // lazy - call when needed
  stringify(dt: Temporal.ZonedDateTime): DateTimeString,
  is(value: unknown): value is DateTimeString,
  now(timezone?: string): DateTimeString,
};
```

SQLite date columns now return `DateTimeString` directly. When you need date math or timezone conversion, call `DateTimeString.parse()` to get a full `Temporal.ZonedDateTime`. The parsing happens once, at the last responsible moment.

## Why This Works

1. **Zero conversion overhead**: Strings pass through APIs, serialization, and storage untouched
2. **Temporal on demand**: `DateTimeString.parse()` gives you full date math capabilities when needed
3. **Drizzle efficiency**: Avoids thousands of synchronous `fromDriver` calls on bulk queries
4. **JSON-native**: Works seamlessly with `JSON.stringify()`, tRPC, and REST APIs

## API Evolution

```typescript
// Old
const dt = DateWithTimezone({ date: new Date(), timezone: 'America/New_York' });
dt.date; // JS Date (mutable, limited API)
dt.toJSON(); // DateWithTimezoneString

// New
const stored = DateTimeString.now('America/New_York'); // "2024-01-01T20:00:00.000Z|America/New_York"
const live = DateTimeString.parse(stored); // Temporal.ZonedDateTime
live.add({ months: 1 }); // Full Temporal API
DateTimeString.stringify(live); // Back to storage format
```
