# Liveness Belongs to the Process, Not the Row

A discriminated union with three variants can still have one variant too many. If one of your states means "this is happening right now," it does not belong in durable storage. The process doing the work already knows it is alive. The moment that process dies, the stored claim becomes a lie that no reader can detect.

Here is a transformation-run result, stored as a row in a Yjs table:

```ts
// Before: three variants, one of them a liveness claim
type Result =
  | { status: 'running' }
  | { status: 'completed'; completedAt: string; output: string }
  | { status: 'failed';    completedAt: string; error: string };
```

```ts
// After: store only the facts; absence means "did not finish"
type Result =
  | { status: 'completed'; completedAt: string; output: string }
  | { status: 'failed';    completedAt: string; error: string };
// `result` is now optional on the row. Liveness is derived, not stored.
```

The two terminal variants are facts. This run finished at this time with this output. This run failed with this error. Facts are what storage is for: write once, read forever. `running` is not a fact. It is a claim about the present, asserted by whatever process is currently executing the run.

## Terminal states are facts; "running" is a claim about right now

The tell is what happens on crash. Quit the app mid-run and the writer never comes back to set the terminal state. The row still says `running`. It will say `running` tomorrow, next week, and the next time you open the app, because nothing is left alive to correct it.

```txt
write { status: 'running' }   <- process A, at kickoff
... process A crashes ...
                              <- the row is now permanently wrong
                              <- and no reader can tell a live run from a dead one
```

Now you reach for the fix that every "status got stuck" bug reaches for: a repair pass on startup that scans for stale `running` rows and resets them. That repair pass is the smell. You are writing code to undo a write you should never have made.

## Absence is the honest third state

Drop the variant and the wedge becomes unrepresentable. A row that never reached a terminal state simply has no `result`, and absence reads honestly in every situation:

```txt
result present                  -> terminal. Render completed or failed.
no result + process is alive    -> running. Show the spinner.
no result + no live process     -> did not finish. Offer retry.
```

The version with a stored `running` could not express that bottom row at all. "Completed" and "crashed mid-run" were durably indistinguishable, so the UI showed a spinner forever and called it running. With absence, a crash leaves a row with a start time and no outcome, which the UI reads as interrupted, with zero repair code anywhere.

## The process already owns liveness

The reason you can delete the stored state is that something else already holds it: the process running the work. In a local-first app that process is usually the same one rendering the UI, so "is this run live" is already in memory as the mutation's pending state. You are not adding a source of truth. You are deleting a stale copy of one that already exists.

This is the same move as finding the owner of a type that feels wrong. Liveness has an owner, and it is not the row. The row owns durable facts; the process owns "what is happening right now." Storing liveness in the row puts a fast-decaying value in a medium built for permanence, and the mismatch surfaces as exactly one bug: the value that outlives the thing it described.

## When the reader is not the writer, store a heartbeat, not a status

The honest caveat: if the process that reads the state is not the process that writes it, in-memory liveness is not visible across the boundary. A second browser tab, or another device syncing the same document, cannot see the writer's pending mutation. There you do need a liveness signal in shared state.

But the fix is still not a `status: 'running'` flag. You store a heartbeat timestamp, which is a fact ("last alive at T"), and derive liveness from its age:

```ts
type Liveness = { heartbeatAt: number };
const isLive = (l: Liveness, graceMs = 3000) => now() - l.heartbeatAt < graceMs;
```

A `running` boolean has no honest reading once the writer dies; it stays true forever. A timestamp has one: it stops advancing, the age crosses the grace window, and every reader independently concludes the run went quiet. Same shape as before. Store the fact, derive the claim, and let the claim decay on its own instead of writing code to retract it.

The rule that survives all of this: a value that is only true while a specific process is alive does not belong in storage that outlives the process. Keep the terminal facts in the row. Keep liveness where it actually lives.
