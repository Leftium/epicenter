# notes-cross-peer

Two-peer minimal repro for the `system.describe` cross-peer fetch.

Both configs construct the same workspace (`epicenter.notes-repro`) with
distinct peer ids, so each appears in the other's awareness. Exercises
`describePeer({ presence, rpc }, peerId)` end-to-end against the deployed API.

## Setup

```bash
bun install                       # picks up the new workspace package
bun x epicenter auth login        # one-time, https://api.epicenter.so
```

## Run

**Terminal 1**: bring peer-a online as a long-lived peer (Ctrl-C to stop):

```bash
bun x epicenter up -C examples/notes-cross-peer/peer-a
```

**Terminal 2**: bring peer-b online too, then dispatch via its daemon to peer-a:

```bash
bun x epicenter up -C examples/notes-cross-peer/peer-b &
bun x epicenter peers -C examples/notes-cross-peer/peer-b
bun x epicenter run notes.actions.notes.add --peer notes-repro-peer-a '{"body":"from peer-b"}' -C examples/notes-cross-peer/peer-b
```

To inspect peer-a's full action manifest from peer-b, write a script
(the CLI no longer offers a flag for this. See `packages/cli/README.md`
under "Local vs. remote"):

```ts
// examples/notes-cross-peer/inspect-peer.ts
import { describePeer } from '@epicenter/workspace';
import { notes } from './peer-b/epicenter.config';

await notes.whenReady;
const result = await describePeer(
	{ presence: notes.presence, rpc: notes.rpc },
	'notes-repro-peer-a',
);
console.log(result.error ?? result.data);
notes[Symbol.dispose]();
```

```bash
bun run examples/notes-cross-peer/inspect-peer.ts
```

## What confirms it works

- `peers` lists `notes-repro-peer-a`, so awareness round-tripped through the API.
- `inspect-peer.ts` prints peer-a's manifest with `actions.notes.add` and its input shape, so `system.describe()` carries the schema.
- `run notes.actions.notes.add --peer notes-repro-peer-a` succeeds, so cross-peer dispatch uses the same RPC channel.

## What confirms it broke

- `ActionNotFound: system.describe` means injection didn't land.
- `inspect-peer.ts` returns `RpcError.PeerNotFound` means awareness never propagated.
- `inspect-peer.ts` hangs or times out means manifest fetch isn't completing.
