# notes-cross-peer

Two-peer minimal repro for the `system.describe` cross-peer fetch.

Both configs construct the same workspace (`epicenter.notes-repro`) with
distinct deviceIds, so each appears in the other's awareness. Exercises
`describePeer(sync, deviceId)` end-to-end against the deployed API.

## Setup

```bash
bun install                       # picks up the new workspace package
bun x epicenter auth login        # one-time, https://api.epicenter.so
```

## Run

**Terminal 1** — bring peer-a online as a long-lived peer (Ctrl-C to stop):

```bash
bun x epicenter up --dir examples/notes-cross-peer/peer-a
```

**Terminal 2** — bring peer-b online too, then dispatch via its daemon to peer-a:

```bash
bun x epicenter up --dir examples/notes-cross-peer/peer-b &
bun x epicenter list --dir examples/notes-cross-peer/peer-b --peer notes-repro-peer-a
bun x epicenter list --dir examples/notes-cross-peer/peer-b --peer notes-repro-peer-a notes.add
bun x epicenter run  --dir examples/notes-cross-peer/peer-b --peer notes-repro-peer-a notes.add '{"body":"from peer-b"}'
```

## What confirms it works

- `list --peer` returns the action tree → `system.describe()` round-tripped
- `list --peer X notes.add` shows `Input fields: body: string (required)` → manifest carries input schemas
- `run --peer X notes.add` succeeds → cross-peer dispatch through the same channel

## What confirms it broke

- `ActionNotFound: system.describe` → injection didn't land
- Tree renders but no input fields on detail → `system.describe()` dropped `input` from the response
- `list --peer` hangs or times out → manifest fetch isn't completing
