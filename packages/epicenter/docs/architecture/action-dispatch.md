# Action Dispatch

How to invoke actions across devices using YJS as the transport layer.

## The Problem

In a multi-device Epicenter network, you sometimes need to invoke actions on a remote device:

- **Server → Browser**: Run a browser-only action (access localStorage, trigger UI)
- **Browser → Server**: Already solved by HTTP endpoints
- **Server → Server**: Run an action on a specific server

The challenge: how does the server "call" the browser when it can't initiate connections?

## The Solution: Command Mailbox

Use the Y.Doc itself as a bidirectional command channel. Since all devices are already connected via YJS sync, we add a `requests` map to the document root:

```
┌─────────────────────────────────────────────────────────────┐
│ Y.Doc Root                                                   │
│                                                              │
│   tables/              ← Existing data                       │
│   ├── posts                                                  │
│   └── users                                                  │
│                                                              │
│   requests/            ← Action dispatch (Y.Map)             │
│   └── { requestId → Request }                                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Terminology

| Term        | Definition                                                  |
| ----------- | ----------------------------------------------------------- |
| **Action**  | A defined operation (query or mutation) that can be invoked |
| **Request** | A request to invoke an action on a target device            |
| **Device**  | Any runtime (browser, server) with a stable `deviceId`      |

Actions are what you define. Requests are how you invoke them remotely.

## Request Shape

Requests use a discriminated union on `status`. No optional keys—each variant has explicit types:

```typescript
type BaseRequest = {
	id: string;
	targetDeviceId: string;
	action: string;
	input: unknown;
	createdAt: number;
	expiresAt: number;
};

type PendingRequest = BaseRequest & {
	status: 'pending';
	completedAt: null;
	output: null;
};

type RunningRequest = BaseRequest & {
	status: 'running';
	completedAt: null;
	output: null;
};

type DoneRequest = BaseRequest & {
	status: 'done';
	completedAt: number;
	output: Result<unknown, unknown>;
};

type Request = PendingRequest | RunningRequest | DoneRequest;
```

The `output` field is `null` until `status === 'done'`. It uses the wellcrafted `Result` type:

```typescript
// Success
{ data: { ... } }

// Error
{ error: { ... } }
```

## Device Identity

Every device needs a stable identity for request routing.

### Browsers

Generate a persistent UUID on first load:

```typescript
function getDeviceId(): string {
	let id = localStorage.getItem('epicenter-device-id');
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem('epicenter-device-id', id);
	}
	return id;
}
```

### Servers

Use Tailscale identity if available, otherwise fall back to hostname:

```typescript
import os from 'os';
import { $ } from 'bun';

async function getServerDeviceId(): Promise<string> {
	// Check for explicit override
	if (process.env.EPICENTER_DEVICE_ID) {
		return process.env.EPICENTER_DEVICE_ID;
	}

	// Try Tailscale identity
	const { stdout, exitCode } = await $`tailscale status --json`
		.nothrow()
		.quiet();

	if (exitCode === 0) {
		const parsed = JSON.parse(stdout.toString());
		const tailscaleId = parsed.Self?.ID;
		if (tailscaleId) {
			return `tailscale-${tailscaleId}`;
		}
	}

	// Fall back to hostname
	return `server-${os.hostname()}`;
}
```

Tailscale IDs are stable across reboots and network changes, making them ideal for device identity.

### Publishing Identity and Actions

Devices publish their identity **and available actions** via YJS awareness:

```typescript
provider.awareness.setLocalState({
	deviceId: getDeviceId(),
	type: 'browser', // or 'server'
	actions: {
		saveToLocalStorage: {
			type: 'mutation',
			input: {
				type: 'object',
				properties: {
					key: { type: 'string' },
					value: { type: 'string' },
				},
				required: ['key', 'value'],
			},
		},
		getClipboard: {
			type: 'query',
			input: null, // no input required
		},
	},
});
```

This lets any device discover:

- Which devices are online
- What actions each device supports
- The JSON Schema for each action's input

Senders can validate inputs before dispatching and know exactly what's available across the network.

## Request Flow

Requests always target a specific device. Check awareness first to ensure the device is online.

```
Sender                          Target Device
   │                                    │
   │ 0. Check awareness: is "abc" online?
   │    If not → fail immediately       │
   │                                    │
   │ 1. Write request                   │
   │    status: "pending"               │
   │    completedAt: null               │
   │    output: null                    │
   │─────────────YJS sync──────────────►│
   │                                    │
   │                            2. Observe new request
   │                               targetDeviceId === myDeviceId? ✓
   │                                    │
   │                            3. Set status="running"
   │                                    │
   │                            4. Execute action locally
   │                                    │
   │                            5. Write completion
   │                               status="done"
   │                               completedAt=Date.now()
   │                               output={ data: {...} }
   │◄─────────────YJS sync─────────────│
   │                                    │
   │ 6. Observe completion              │
   │    Resolve promise with output     │
   │    Clean up (delete request)       │
   │                                    │
```

Since requests are explicitly targeted and we check awareness first, there's no race condition—only one device will ever process each request.

## Awareness vs Requests

We use **both**, for different purposes:

| Awareness                                         | Requests (Y.Map)                            |
| ------------------------------------------------- | ------------------------------------------- |
| Ephemeral (lost on disconnect)                    | Durable (survives reconnect)                |
| Broadcast to all peers                            | Targeted by deviceId                        |
| Good for: identity, online status, action schemas | Good for: action dispatch, request/response |

**Use awareness for discovery. Use the requests map for dispatch.**

## Garbage Collection

Completed requests should be cleaned up:

```typescript
function cleanupRequests(requests: Y.Map<Request>) {
	const now = Date.now();
	const ONE_HOUR = 60 * 60 * 1000;

	for (const [id, req] of requests.entries()) {
		// Delete completed requests older than 1 hour
		if (req.status === 'done' && now - req.completedAt > ONE_HOUR) {
			requests.delete(id);
		}
		// Delete expired pending/running requests
		if (req.status !== 'done' && now > req.expiresAt) {
			requests.delete(id);
		}
	}
}
```

## Targeting and Online Check

Requests **must** specify a `targetDeviceId`. Before dispatching:

1. Read awareness to find online devices
2. Verify target device is online
3. If offline → fail immediately or queue with timeout

```typescript
function dispatch(targetDeviceId: string, action: string, input: unknown) {
	const awareness = provider.awareness.getStates();
	const targetOnline = [...awareness.values()].some(
		(state) => state.deviceId === targetDeviceId,
	);

	if (!targetOnline) {
		return { error: { message: 'Target device is offline' } };
	}

	const now = Date.now();
	const id = nanoid();

	// Write request to Y.Doc
	requests.set(id, {
		id,
		targetDeviceId,
		action,
		input,
		status: 'pending',
		createdAt: now,
		expiresAt: now + 30_000, // 30 second timeout
		completedAt: null,
		output: null,
	});
}
```

This eliminates race conditions—only the targeted device processes the request.

## Integration with Existing Architecture

This pattern layers on top of the existing sync architecture:

```
┌─────────────────────────────────────────────────────────────┐
│ Transport: YJS WebSocket Sync (existing)                     │
│                                                              │
│   Y.Doc State:                                               │
│   - tables/     → data                                       │
│   - requests/   → action dispatch (new)                      │
│                                                              │
│   Awareness:                                                 │
│   - deviceId    → stable identity                            │
│   - type        → browser/server                             │
│   - actions     → available actions + JSON Schema (new)      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

No new connections needed. The same sync providers that replicate your data also handle action discovery and dispatch.

## When to Use This vs HTTP

| Use HTTP                    | Use YJS Dispatch               |
| --------------------------- | ------------------------------ |
| Browser → Server (standard) | Server → Browser               |
| Public API endpoints        | Cross-device action invocation |
| High-throughput operations  | Targeted device operations     |
| External clients            | Internal network only          |

For browser → server, HTTP is simpler and more familiar. Use YJS dispatch when you need to reach a device that can't accept incoming connections.

## Related Documentation

- [Device Identity](./device-identity.md): How devices identify themselves
- [Network Topology](./network-topology.md): Connection patterns
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Multi-device sync details
