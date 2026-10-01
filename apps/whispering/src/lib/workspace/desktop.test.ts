/**
 * Opening a workspace, and the desktop workspace over a bridge that fails.
 *
 * Opening answers with a Result: an unreachable folder host or a refused
 * browser folder is returned as that refusal, and the other storage is never
 * opened in its place. An opened desktop workspace answers transcription and
 * transformation with a Result whether the host is unreachable, faults, or
 * succeeds, so the product never waits on a rejected call.
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { encode } from '../bridge/codec.js';
import { openBrowserWorkspace } from './browser.js';
import { openDesktopWorkspace } from './desktop.js';

const answer = (ok: unknown) => Response.json({ ok: encode(ok) });

test('a folder host that does not answer is the refusal, and no other storage is opened', async () => {
	const requested: string[] = [];
	const refused = expectErr(
		await openDesktopWorkspace({
			origin: 'http://127.0.0.1:4999',
			token: 'test-token',
			fetch: async (input) => {
				requested.push(new URL(input).pathname);
				throw new TypeError('Load failed');
			},
		}),
	);

	expect(refused.name).toBe('FolderHost');
	expect(refused.message).toContain('Load failed');
	// One request to the host, and nothing after it.
	expect(requested).toEqual(['/bridge/app']);
});

test('a browser folder that is refused is returned as that refusal', async () => {
	// This process has no IndexedDB, as a server render has none.
	const none = expectErr(await openBrowserWorkspace());
	expect(none.name).toBe('BrowserFolder');
	if (none.name === 'BrowserFolder')
		expect(none.refusal.name).toBe('NoIndexedDb');
	expect(none.message).toContain('cannot be opened');

	// Inside a desktop app the browser opener refuses, even where storage exists.
	const scope = globalThis as { isTauri?: boolean };
	scope.isTauri = true;
	try {
		const inside = expectErr(await openBrowserWorkspace());
		if (inside.name === 'BrowserFolder')
			expect(inside.refusal.name).toBe('InsideTauri');
		expect(inside.message).toContain('Browser storage is not used');
	} finally {
		delete scope.isTauri;
	}
});

test('a failed transcription call is a Result, and the next call still works', async () => {
	let transcribeCalls = 0;
	const opened = await openDesktopWorkspace({
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
	const workspace = expectOk(opened);
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

test('a failed transformation call is a Result, and the next call still works', async () => {
	let transformCalls = 0;
	const sent: unknown[] = [];
	const opened = await openDesktopWorkspace({
		origin: 'http://127.0.0.1:4999',
		token: 'test-token',
		fetch: async (input, init) => {
			if (input.endsWith('/bridge/events'))
				return new Response(new ReadableStream({ start() {} }));
			const body = JSON.parse(String(init?.body)) as {
				op?: string;
				path?: string[];
				payload?: unknown;
			};
			if (body.op === 'info')
				return answer({
					root: '/data',
					shell: '/bin/sh',
					debug: false,
					fixture: null,
					fixtureRefused: false,
					defaults: { transcriptionBaseUrl: 'u', transcriptionModel: 'm' },
					credentialPresent: true,
					credentialFromEnvironment: false,
				});
			if (body.path?.join('.') === 'git.snapshot') return answer({});
			if (body.op === 'transform') {
				transformCalls += 1;
				sent.push(body.payload);
				if (transformCalls === 1) throw new TypeError('Load failed');
				if (transformCalls === 2)
					return Response.json({ fault: 'host fault' }, { status: 500 });
				return answer({ data: { text: 'ok' }, error: null });
			}
			return Response.json({ fault: 'unexpected call' }, { status: 500 });
		},
	});
	const workspace = expectOk(opened);
	const request = { baseUrl: 'u', model: 'm', prompt: 'p', input: 'text' };

	const unreachable = await workspace.transform(request);
	expect(unreachable.error?.name).toBe('HostUnavailable');
	expect(unreachable.error?.message).toContain('Load failed');

	const faulted = await workspace.transform(request);
	expect(faulted.error?.name).toBe('HostUnavailable');
	expect(faulted.error?.message).toContain('host fault');

	expect((await workspace.transform(request)).data).toEqual({ text: 'ok' });
	// The page sends what to transform and never a key: the host adds it.
	expect(sent).toEqual([request, request, request]);
	await workspace.close();
});
