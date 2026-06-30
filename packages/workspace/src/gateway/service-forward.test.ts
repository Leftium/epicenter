/**
 * The second vocabulary, proven end to end in one process: an HTTP service
 * reached as an ordinary `Connection { baseUrl }` over the SAME relay floor that
 * carries MCP. A real localhost forward + a real localhost service + the real
 * relay-channel transport and acceptor, across a loopback that stands in for the
 * relay's forwarding (its routing/refusal is unit-tested in `packages/server`
 * `channel-router.test.ts`).
 *
 * This is the native slice (no in-TypeScript HTTP codec): the HTTP is spoken by
 * Bun's `fetch` client and `Bun.serve` at the two ends; the forward and the relay
 * only move bytes. It is NOT the live two-device smoke (a running relay + a daemon
 * `up --relay-expose whisper` + a real whisper box), which a headless environment
 * cannot stand up; the loopback is the ceiling here.
 */

import { expect, test } from 'bun:test';
import { asNodeId } from '../document/node-id.js';
import { asRouteName } from '../peer-transport.js';
import { createChannelAcceptor } from '../relay-channel/acceptor.js';
import type { ChannelFrame } from '../relay-channel/protocol.js';
import {
	type ChannelPort,
	createRelayChannelTransport,
} from '../relay-channel/transport.js';
import { openRouteTarget } from './route-table.js';
import { createServiceForward } from './service-forward.js';

/**
 * Two {@link ChannelPort}s wired so each side's `send` reaches the other's
 * listeners (a 2-party relay stand-in). Mirrors `relay-channel/transport.test.ts`;
 * the relay's real routing/refusal is tested in `packages/server`.
 */
function loopbackPorts(): { caller: ChannelPort; target: ChannelPort } {
	const callerListeners = new Set<(frame: ChannelFrame) => void>();
	const targetListeners = new Set<(frame: ChannelFrame) => void>();
	const deliver = (
		listeners: Set<(frame: ChannelFrame) => void>,
		frame: ChannelFrame,
	) => {
		// Defer like a real socket so a send inside a listener does not reenter.
		queueMicrotask(() => {
			for (const listener of [...listeners]) listener(frame);
		});
	};
	return {
		caller: {
			send: (frame) => deliver(targetListeners, frame),
			onFrame: (listener) => {
				callerListeners.add(listener);
				return () => callerListeners.delete(listener);
			},
		},
		target: {
			send: (frame) => deliver(callerListeners, frame),
			onFrame: (listener) => {
				targetListeners.add(listener);
				return () => targetListeners.delete(listener);
			},
		},
	};
}

test('a service route is reachable as an ordinary HTTP Connection over the relay floor', async () => {
	// The remote device's local service: an OpenAI-compatible transcription
	// endpoint, the exact wire `transcribe()` speaks. Stands in for a whisper box.
	const whisper = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(req) {
			const url = new URL(req.url);
			if (
				req.method !== 'POST' ||
				url.pathname !== '/v1/audio/transcriptions'
			) {
				return new Response('not found', { status: 404 });
			}
			// Read the multipart form back so the assertion proves the request
			// survived the byte pipe intact, not just that bytes flowed.
			const form = await req.formData();
			const model = String(form.get('model'));
			return Response.json({ text: `transcribed by ${model}` });
		},
	});

	// `Bun.serve().port` is `number | undefined` (undefined only for a unix socket);
	// a TCP server on port 0 always binds a real port.
	const whisperPort = whisper.port;
	if (whisperPort === undefined) throw new Error('Bun.serve did not bind a port');

	// The relay floor (a 2-party loopback) + the remote device's acceptor serving a
	// `whisper` SERVICE route by net.connect-ing to the box above.
	const wire = loopbackPorts();
	const acceptor = createChannelAcceptor(wire.target, ({ route }) =>
		route === 'whisper'
			? openRouteTarget({
					kind: 'service',
					service: { port: whisperPort },
					relay: 'exposed',
				})
			: null,
	);

	// The consumer: a localhost forward the daemon owns, pointed at the remote
	// `whisper` route over the relay. A `Connection.baseUrl` at this port reaches
	// the remote service unchanged.
	const transport = createRelayChannelTransport(wire.caller);
	const forward = await createServiceForward({
		transport,
		target: asNodeId('whisper-box'),
		route: asRouteName('whisper'),
	});

	// What `transcribe(blob, resolveConnection({ baseUrl }), { model })` does on the
	// wire: a keyless localhost connection resolves to `{ fetch: globalThis.fetch,
	// baseURL }`, so this plain multipart POST IS the identical code path. No
	// `@epicenter/client` import (workspace does not depend on it); the byte path is
	// the one transcribe rides, `ResolvedConnection` untouched.
	const form = new FormData();
	form.append(
		'file',
		new File([new Uint8Array([1, 2, 3])], 'audio.wav', { type: 'audio/wav' }),
	);
	form.append('model', 'whisper-1');
	const response = await fetch(
		`http://127.0.0.1:${forward.port}/v1/audio/transcriptions`,
		{ method: 'POST', body: form },
	);
	const body = (await response.json()) as { text: string };

	expect(response.ok).toBe(true);
	expect(body.text).toBe('transcribed by whisper-1');

	await forward.close();
	transport.close();
	acceptor.close();
	await whisper.stop(true);
});
