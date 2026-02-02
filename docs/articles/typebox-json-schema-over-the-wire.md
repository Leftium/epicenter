# TypeBox: JSON Schema Over the Wire

Because TypeBox schemas are just JSON Schema objects, you can serialize them across the network, reconstruct them on the other side, and compile them into validators at runtime. No code generation, no shared build-time dependencies.

## The Pattern

1. Define schemas on one device
2. Serialize them as JSON
3. Send them over the network
4. Reconstruct and compile them on the receiving device

```typescript
// Device A: Expose available actions
const actions = {
	createUser: {
		input: {
			type: 'object',
			required: ['name', 'email'],
			properties: {
				name: { type: 'string' },
				email: { type: 'string', format: 'email' },
			},
		},
		output: {
			type: 'object',
			required: ['id'],
			properties: {
				id: { type: 'string' },
			},
		},
	},
};

// Broadcast over WebSocket, HTTP, etc.
const payload = JSON.stringify(actions);
```

```typescript
// Device B: Receive and compile
import { Compile } from 'typebox/compile';

const actions = JSON.parse(payload);

const inputValidator = Compile(actions.createUser.input);
const outputValidator = Compile(actions.createUser.output);

// Now Device B can validate requests before sending
// and validate responses when receiving
```

## Why This Matters for Epicenter

In Epicenter's architecture, devices expose actions to each other. When a device connects, it broadcasts its available actions along with their JSON Schema definitions. Other devices can then:

1. **Discover** what actions are available
2. **Validate requests** before sending them
3. **Validate responses** when receiving them
4. **Generate UI** or documentation from the schemas

The schema becomes a contract that travels with the action definition. No need for code generation. No need for shared type definitions at build time. The schema is the source of truth, and it's portable.

## Schema as Contract

Traditional approaches require both sides to share type definitions at compile time. With JSON Schema over the wire:

- Sender defines the contract (schema)
- Contract travels with the message
- Receiver compiles and enforces the contract at runtime

This enables true runtime discovery. A new device can connect, broadcast its capabilities, and other devices immediately know how to interact with it; all without redeploying or rebuilding anything.

## Summary

TypeBox schemas are JSON Schema. JSON Schema is just JSON. JSON travels over the wire. This enables runtime schema discovery and validation across distributed systems without shared build-time dependencies.

See also: [TypeBox is a Beast](./typebox-is-a-beast.md) for more on TypeBox's core capabilities.
