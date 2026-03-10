# Device Identity

This document explains how devices identify themselves in an Epicenter network and how identities are used for blob discovery and sync.

## Overview

Device identity serves two purposes:

1. **Blob Registry**: Servers announce their identity so other devices know where to fetch blobs
2. **Awareness**: Optional user presence (cursors, names) in collaborative editing

## Server Identity

Servers identify themselves by their **reachable WebSocket URL**.

### Format

```
ws://<hostname>:<port>/sync
wss://<hostname>:<port>/sync  (TLS)
```

### Examples

| Network         | Identity URL                                |
| --------------- | ------------------------------------------- |
| Tailscale       | `ws://laptop-a.my-tailnet.ts.net:3913/sync` |
| Local Network   | `ws://192.168.1.50:3913/sync`               |
| Public Internet | `wss://sync.example.com/sync`               |

### Configuration

The server URL is configured at startup:

```typescript
const MY_URL =
	process.env.EPICENTER_URL ?? `ws://${os.hostname()}.tailnet:3913/sync`;

const server = createEpicenterServer({
	port: 3913,
	blobSync: {
		serverUrl: MY_URL, // Used in blob registry
	},
});
```

### Auto-Detection with Tailscale

On Tailscale networks, you can auto-detect the hostname:

```typescript
import { execSync } from 'child_process';

function getTailscaleHostname(): string | null {
	try {
		const status = execSync('tailscale status --json', { encoding: 'utf-8' });
		const parsed = JSON.parse(status);
		return parsed.Self?.DNSName?.replace(/\.$/, '') ?? null;
	} catch {
		return null;
	}
}

const hostname = getTailscaleHostname() ?? os.hostname();
const MY_URL = `ws://${hostname}:3913/sync`;
```

## Client Identity

Clients (browsers) **do not need a public identity** because they cannot accept incoming connections.

### Internal Tracking (Optional)

For internal purposes, clients may use:

| Type                    | Purpose            | Persistence                     |
| ----------------------- | ------------------ | ------------------------------- |
| Yjs `clientID`          | Deduplication      | Per session (changes on reload) |
| `localStorage` deviceId | Awareness/presence | Persistent                      |

```typescript
// Generate persistent device ID for awareness
function getDeviceId(): string {
	let id = localStorage.getItem('epicenter-device-id');
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem('epicenter-device-id', id);
	}
	return id;
}
```

### NOT Used In Blob Registry

Clients are never listed in `_blobRegistry.holders` because:

- They cannot accept incoming connections
- Other devices cannot reach them to request blobs

## Identity in Blob Registry

The blob registry uses server identities to track blob availability:

```typescript
// Y.Doc structure
_blobRegistry: Y.Map<string, {
  holders: string[];   // Server URLs that have this blob
  size: number;
  chunkCount: number;
}>

// Example entry
{
  "sha256:abc123...": {
    holders: [
      "ws://laptop-a.tailnet:3913/sync",
      "ws://laptop-b.tailnet:3913/sync"
    ],
    size: 307200,
    chunkCount: 3
  }
}
```

### Adding to Registry

When a server stores a blob, it adds itself:

```typescript
function announceHaveBlob(hash: string) {
	const entry = blobRegistry.get(hash);
	const holders = entry?.holders ?? [];

	if (!holders.includes(MY_URL)) {
		blobRegistry.set(hash, {
			...entry,
			holders: [...holders, MY_URL],
		});
	}
}
```

### Removing from Registry

When a server deletes a blob, it removes itself:

```typescript
function announceDeletedBlob(hash: string) {
	const entry = blobRegistry.get(hash);
	if (!entry) return;

	const newHolders = entry.holders.filter((h) => h !== MY_URL);

	if (newHolders.length === 0) {
		blobRegistry.delete(hash);
	} else {
		blobRegistry.set(hash, { ...entry, holders: newHolders });
	}
}
```

## Identity Lifecycle

### Server Startup

```
1. Server starts on port 3913
2. Determines its URL (config or auto-detect)
3. Connects to other servers (if configured)
4. Scans local blob store
5. Announces all existing blobs to registry
```

### Server Shutdown

```
1. Server receives shutdown signal
2. Removes itself from all blob registry entries
3. Closes WebSocket connections
4. Exits
```

### Stale Entries

If a server crashes without cleanup, stale entries remain in the registry. This is handled gracefully:

```typescript
async function fetchBlob(hash: string): Promise<Blob | null> {
	const holders = blobRegistry.get(hash)?.holders ?? [];

	for (const holder of holders) {
		try {
			return await requestBlobFrom(holder, hash);
		} catch {
			// Holder unreachable, try next
			continue;
		}
	}

	return null; // None available
}
```

**Optional cleanup**: Periodically remove stale holders that haven't been reachable for N hours.

## Related Documentation

- [Network Topology](./network-topology.md): Node types and connections
- [Blob Registry](../blobs/registry.md): How the registry syncs via Yjs
- [Security](./security.md): Identity verification and authentication
