/**
 * The desktop workspace over a bridge that fails. A workspace answers
 * transcription with a Result whether the host is unreachable, faults, or
 * succeeds, so the product never waits on a rejected call.
 */
import { expect, test } from 'bun:test';
import { encode } from '../bridge/codec.js';
import { openDesktopWorkspace } from './desktop.js';

const answer = (ok: unknown) => Response.json({ ok: encode(ok) });

test('a failed transcription call is a Result, and the next call still works', async () => {
	let transcribeCalls = 0;
	const workspace = await openDesktopWorkspace({
		origin: 'http://127.0.0.1:4999',
		token: 'test-token',
		fetch: async (input, init) => {
			// An event stream that stays open and silent.
			if (input.endsWith('/bridge/events'))
				return new Response(new ReadableStream({ start() {} }));
			const body = JSON.parse(String(init?.body)) as {
				op?: string;
				path?: string[];
			};
			if (body.op === 'info')
				return answer({
					root: '/data',
					shell: '/bin/sh',
					debug: false,
					fixture: null,
					fixtureRefused: false,
					defaults: { transcriptionBaseUrl: 'u', transcriptionModel: 'm' },
					credentialPresent: false,
					credentialFromEnvironment: false,
				});
			if (body.path?.join('.') === 'git.snapshot') return answer({});
			if (body.op === 'transcribe') {
				transcribeCalls += 1;
				if (transcribeCalls === 1) throw new TypeError('Load failed');
				if (transcribeCalls === 2)
					return Response.json({ fault: 'host fault' }, { status: 500 });
				return answer({ data: { text: 'ok' }, error: null });
			}
			return Response.json({ fault: 'unexpected call' }, { status: 500 });
		},
	});
	const request = { audioPath: 'recordings/a.wav', baseUrl: 'u', model: 'm' };

	const unreachable = await workspace.transcribe(request);
	expect(unreachable.error?.name).toBe('HostUnavailable');
	expect(unreachable.error?.message).toContain('Load failed');

	const faulted = await workspace.transcribe(request);
	expect(faulted.error?.name).toBe('HostUnavailable');
	expect(faulted.error?.message).toContain('host fault');

	expect((await workspace.transcribe(request)).data).toEqual({ text: 'ok' });
	await workspace.close();
});
