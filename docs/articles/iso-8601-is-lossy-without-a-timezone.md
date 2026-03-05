# ISO 8601 Is Lossy Without a Timezone

When designing Epicenter, one of the first things we needed was a JSON-serializable way to store dates that wouldn't lose information. The obvious choice is ISO 8601, but it has a gap that most people don't think about until it bites them: it stores an offset, not a timezone.

## Offset is not timezone

An ISO 8601 string like `2024-03-10T12:00:00-05:00` tells you the UTC offset at that moment. It doesn't tell you which timezone produced it. `-05:00` could be `America/New_York` in winter, `America/Bogota` year-round, or `America/Lima`. They all share that offset right now but diverge when DST kicks in.

```
2024-03-10T12:00:00-05:00   ← America/New_York (EST)
2024-03-10T12:00:00-05:00   ← America/Bogota (COT, no DST)

// One week later, after DST transition:
2024-03-17T12:00:00-04:00   ← America/New_York (EDT)
2024-03-17T12:00:00-05:00   ← America/Bogota (still COT)
```

If you stored `-05:00` and later need to compute "what time is it there next Tuesday?", you can't. The offset alone doesn't carry enough information to determine future transitions. You need the IANA timezone name.

## What you actually need to reconstruct a date

Two things: the instant (a point on the UTC timeline) and the IANA timezone (e.g. `America/New_York`). With both, you can always recompute the correct local time, offset, and DST state for any past or future moment.

Without the timezone, you can display the date as it was at that instant. You can't answer questions like "what's the next occurrence of 9am in this user's timezone?" or "add 1 day" (which might be 23 or 25 hours across a DST boundary).

## The options we compared

| Format | Example | ~Bytes | Readable | Timezone |
|---|---|---|---|---|
| Unix ms (number) | `1709510400000` | 13 | No | No |
| Unix seconds (number) | `1709510400` | 10 | No | No |
| ISO 8601 (UTC) | `"2024-03-04T00:00:00.000Z"` | 26 | Yes | No |
| ISO 8601 + offset | `"2024-03-04T00:00:00-05:00"` | 27 | Yes | Offset only (lossy) |
| Pipe-delimited string | `"2024-03-04T00:00:00.000Z\|America/New_York"` | ~42 | Yes | Yes (IANA) |
| JSON object `{iso, tz}` | `{"iso":"...Z","tz":"America/New_York"}` | ~55 | Yes | Yes (IANA) |

Unix timestamps are the most compact but completely unreadable. You can't glance at `1709510400000` and know what day it is. ISO 8601 is readable and sorts lexicographically, but loses the timezone. The JSON object preserves everything but costs ~13 extra bytes of key names and braces for every single date.

## What we picked: pipe-delimited string

```
2024-03-04T00:00:00.000Z|America/New_York
```

A single string with the ISO UTC timestamp and the IANA timezone separated by a pipe. The pipe works because it's not a valid character in either ISO dates or IANA timezone names, so parsing is unambiguous: split on `|`, done.

```typescript
type DateTimeString = `${UtcIsoString}|${TimezoneId}` & Brand<'DateTimeString'>;

// Serialize
const stored = `${date.toISOString()}|${timezone}`;

// Deserialize
const [isoUtc, timezone] = stored.split('|');
```

It costs about 16 more bytes than a plain ISO string. In exchange we get lossless timezone preservation, a single string value (works as a map key, sorts reasonably, no nested objects), and something a developer can read at a glance in the database.

## Why readability matters to us

Epicenter stores data in SQLite on the user's device. When debugging sync issues or inspecting local state, being able to open the database and immediately see `2024-03-04T00:00:00.000Z|America/New_York` is worth more than saving 16 bytes. Unix timestamps would require a conversion tool every time. The pipe format is self-documenting: you can see both the UTC instant and the timezone without any tooling.

The 16-byte overhead across thousands of date fields is negligible compared to the time saved not having to decode opaque numbers during development.

## The tradeoff is explicit

We traded minimal space efficiency for lossless timezone storage and human readability. If an application only needs UTC instants and never does timezone-aware date math, a plain ISO string or even a Unix timestamp is fine. But the moment you need to answer "what time is it in this user's timezone next week?", you need the IANA zone name, and you need it stored alongside the instant. Bolting it on after the fact means migrating every date column.

We'd rather pay 16 bytes per date up front than discover the offset is lossy six months in.
