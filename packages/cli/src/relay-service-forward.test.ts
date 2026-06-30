/**
 * Cross-package integration proof: the literal `transcribe()` from
 * `@epicenter/client` reaches a remote HTTP service over the relay floor's
 * service-forward primitive from `@epicenter/workspace`. The CLI is the only
 * package depending on BOTH, so this is the one place the two real symbols meet.
 *
 * It wires the consumer side (a localhost forward over the relay) to a producer
 * side (an acceptor serving a `whisper` SERVICE route by net.connect-ing to a
 * `Bun.serve` transcription box) across a 2-party loopback that stands in for the
 * relay's blind forwarding (the relay's own routing/refusal is unit-tested in
 * `packages/server`). Unlike the workspace `service-forward.test.ts` (which posts a
 * hand-rolled multipart form), this drives the EXACT client call an app makes:
 * `transcribe(blob, resolveConnection({ baseUrl }), { model })`. So it proves the
 * service route is reached by the real client symbols, `ResolvedConnection`
 * untouched, with no awareness of the relay.
 *
 * It is NOT the live two-device smoke (a running relay + a daemon
 * `up --relay-service whisper=<port>` on one box + this device's
 * `up --relay-forward whisper@<nodeId>` + a real whisper box). The loopback is the
 * ceiling here: it does not exercise keep-alive, large audio bodies, or multiple
 * requests on one connection. See `packages/cli/README.md` for that runbook.
 */

import { expect, test } from 'bun:test';
import { resolveConnection, transcribe } from '@epicenter/client';
import { asNodeId } from '@epicenter/workspace';
import { createServiceForward, openRouteTarget } from '@epicenter/workspace/node';
import {
	asRouteName,
	type ChannelFrame,
	type ChannelPort,
	createChannelAcceptor,
	createRelayChannelTransport,
} from '@epicenter/workspace/relay-channel';

/**
 * Two {@link ChannelPort}s wired so each side's `send` reaches the other's
 * listeners: a 2-party relay stand-in. The deferred delivery mirrors a real socket
 * so a send inside a listener does not reenter.
 */
function loopbackPorts(): { caller: ChannelPort; target: ChannelPort } {
	const callerListeners = new Set<(frame: ChannelFrame) => void>();
	const targetListeners = new Set<(frame: ChannelFrame) => void>();
	const deliver = (
		listeners: Set<(frame: ChannelFrame) => void>,
		frame: ChannelFrame,
	) => {
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

test('transcribe() reaches a remote service route as an ordinary Connection over the relay floor', async () => {
	// The remote device's local service: an OpenAI-compatible transcription endpoint,
	// the exact wire `transcribe()` speaks. Stands in for a whisper box.
	const whisper = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method !== 'POST' || url.pathname !== '/v1/audio/transcriptions') {
				return new Response('not found', { status: 404 });
			}
			// Read the multipart form back so the assertion proves the request survived
			// the byte pipe intact, not just that bytes flowed.
			const form = await req.formData();
			const model = String(form.get('model'));
			const file = form.get('file');
			const byteLength = file instanceof Blob ? (await file.arrayBuffer()).byteLength : 0;
			return Response.json({ text: `transcribed ${byteLength}B by ${model}` });
		},
	});
	const whisperPort = whisper.port;
	if (whisperPort === undefined) throw new Error('Bun.serve did not bind a port');

	// The producer side: the relay floor (a 2-party loopback) + the remote device's
	// acceptor serving a `whisper` SERVICE route by net.connect-ing to the box above.
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

	// The consumer side: a localhost forward the daemon owns, pointed at the remote
	// `whisper` route over the relay. A `Connection.baseUrl` at this port reaches the
	// remote service unchanged.
	const transport = createRelayChannelTransport(wire.caller);
	const forward = await createServiceForward({
		transport,
		target: asNodeId('whisper-box'),
		route: asRouteName('whisper'),
	});

	// The literal app call: a keyless localhost connection resolves to a bare fetch,
	// and `transcribe` POSTs its multipart form through the forward to the remote
	// service, never learning the relay exists.
	const audio = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/wav' });
	const { data: text, error } = await transcribe(
		audio,
		resolveConnection({ baseUrl: `http://127.0.0.1:${forward.port}/v1` }),
		{ model: 'whisper-1' },
	);

	expect(error).toBeNull();
	expect(text).toBe('transcribed 5B by whisper-1');

	await forward.close();
	transport.close();
	acceptor.close();
	await whisper.stop(true);
});
