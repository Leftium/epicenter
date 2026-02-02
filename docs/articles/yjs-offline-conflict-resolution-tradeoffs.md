# Yjs Isn't Offline-Friendly (And Why That's a Deliberate Choice)

Here's a hot take: Yjs uses client IDs rather than timestamps to resolve concurrent edits. This means it's optimized for real-time collaboration, not offline-first workflows.

Let me explain what I mean.

When two devices edit the same Y.Map value and later sync, Yjs doesn't ask "which edit happened more recently?" It asks "which client ID is higher?" The higher client ID wins. Always.

At first glance, this seems broken. Imagine you edit a cell on your phone Monday, then edit the same cell on your laptop Tuesday. They sync on Wednesday. Your laptop might lose - not because it edited earlier, but because your phone happened to get a higher client ID during that session.

```
Phone (client ID: 847)          Laptop (client ID: 523)
        │                               │
        │  Monday: set cell to "A"      │
        │                               │
        │                               │  Tuesday: set cell to "B"
        │                               │
        └───────────┬───────────────────┘
                    │
              Wednesday: sync
                    │
                    ▼
           Result: "A" wins
           (847 > 523, regardless of time)
```

Your Tuesday edit vanishes. The Monday edit wins because 847 > 523.

This feels wrong. If you're building something like Notion or Google Sheets, you'd expect "last write wins" semantics. The most recent edit should stick around, right?

## The Misconception I Had

My first reaction was: "So one device just always wins? That's terrible for multi-device users."

But that's not quite accurate. Client IDs are assigned per-session, not per-device permanently. Your phone doesn't always beat your laptop. It's whichever session happened to get the higher ID for that particular sync.

Still arbitrary. But less consistently unfair than it sounds.

The "one guy always wins" scenario I imagined - where Bob's edits perpetually overwrite Alice's - doesn't actually happen. It's more like a coin flip that happens to use client IDs instead of actual randomness.

## Why Not Just Use Timestamps?

The obvious fix seems to be: use timestamps. Hybrid Logical Clocks (HLC) give you "last write wins" semantics. TinyBase and other CRDT-like systems take this approach.

Kevin Jahns (Yjs's creator) has addressed this directly. His argument: you can't trust logical clocks.

Clock manipulation happens. NTP corrections happen. Devices with stale batteries happen. A phone that's been offline for a week might have drifted. A user might have manually set their clock forward. An NTP sync might jump time backwards.

With timestamps, these edge cases create unpredictable behavior. An edit from "the future" could overwrite everything. A clock correction could make recent edits appear stale.

With client ID ordering, the behavior is at least deterministic. Every peer will converge to the same state. You might not like which edit won, but you'll never have peers disagreeing about the final result.

Here's the philosophical core: would you rather be deterministically wrong or unpredictably wrong?

Client ID ordering is deterministically wrong. The "wrong" edit might win, but at least it wins consistently across all peers.

Timestamp ordering is unpredictably wrong. It usually does what you expect, but when clocks misbehave, you get weird inconsistencies that are hard to debug.

## When Each Approach Makes Sense

For real-time collaboration where devices are mostly online, client ID ordering works fine. Conflicts are rare, and when they happen, immediate resolution matters more than "fairness."

For offline-heavy workflows where a user edits across multiple devices over days before syncing, timestamp-based approaches feel more intuitive. You expect your most recent work to stick.

For text and sequences, Yjs's approach is actually superior regardless. You don't want "last write wins" for collaborative text editing. If two people type at the same position, both insertions should appear. Yjs handles this beautifully. The client ID criticism really only applies to atomic register-like values in Y.Map.

## The Pragmatic Middle Ground

You can build hybrid logical clock semantics on top of Yjs. Store your own timestamps in the data, implement your own conflict resolution, and use Yjs purely for sync and storage. You get Yjs's excellent performance characteristics with whatever conflict semantics you actually want.

This is probably the right approach if you're building an offline-first app where "last write wins" matters. Don't fight Yjs's design - work with it and add the semantics you need at a higher layer.

The underlying insight: Yjs made a deliberate tradeoff. It prioritized consistency and real-time collaboration over intuitive offline behavior. That's not a bug. It's a design decision with real reasoning behind it.

Whether it's the right tradeoff for your app is a different question.
