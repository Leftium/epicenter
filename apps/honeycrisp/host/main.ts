/**
 * The folder host process. The desktop shell starts it; it can also be run
 * alone for development.
 *
 * Environment:
 *   HONEYCRISP_ROOT            notes directory. Default
 *                              ~/Epicenter/local/so.epicenter.honeycrisp
 *   HONEYCRISP_HOST_TOKEN      the bridge secret. Required unless
 *                              HONEYCRISP_HOST_PAGE_TOKEN=1.
 *   HONEYCRISP_UI_DIST         the built page. Default ../build-desktop
 *   HONEYCRISP_HOST_PORT       loopback port. Default: any free port.
 *   HONEYCRISP_SHELL=1         a shell owns this process: exit when stdin
 *                              closes, read `close-requested` lines from it.
 *   HONEYCRISP_HOST_PAGE_TOKEN=1  no shell: generate a token and put it in
 *                              the served page. Development only.
 *   HONEYCRISP_FAULTS=1        enable fault injection. Refused unless
 *                              HONEYCRISP_ROOT names the directory.
 *   HONEYCRISP_HOLD_SAVES=1, HONEYCRISP_SAVE_DELAY_MS, HONEYCRISP_FAIL_SAVES,
 *   HONEYCRISP_FAIL_COMMITS    initial faults.
 *
 * The first stdout line is `{"ready":true,"port":<n>,"root":"<path>"}`.
 * A later `{"quit":true}` line is the page's permission for the shell to exit.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APPS } from '@epicenter/constants/apps';
import type { Faults } from '../src/lib/bridge/contract.js';
import { createFolderHost } from './serve.js';

const env = process.env;
const explicitRoot = env.HONEYCRISP_ROOT?.trim() || undefined;
const root =
	explicitRoot ?? join(homedir(), 'Epicenter', 'local', APPS.HONEYCRISP.id);
const pageToken = env.HONEYCRISP_HOST_PAGE_TOKEN === '1';
const token =
	env.HONEYCRISP_HOST_TOKEN ||
	(pageToken ? crypto.randomUUID() + crypto.randomUUID() : undefined);
if (token === undefined) {
	console.error(
		'HONEYCRISP_HOST_TOKEN is required (or HONEYCRISP_HOST_PAGE_TOKEN=1 to run without a shell).',
	);
	process.exit(2);
}

let faults: Partial<Faults> | undefined;
if (env.HONEYCRISP_FAULTS === '1') {
	if (explicitRoot === undefined) {
		console.error(
			'HONEYCRISP_FAULTS=1 needs HONEYCRISP_ROOT: fault injection never runs against the default notes directory.',
		);
		process.exit(2);
	}
	faults = {
		holdSaves: env.HONEYCRISP_HOLD_SAVES === '1',
		saveDelayMs: Number(env.HONEYCRISP_SAVE_DELAY_MS) || 0,
		failSaves: Number(env.HONEYCRISP_FAIL_SAVES) || 0,
		failCommits: Number(env.HONEYCRISP_FAIL_COMMITS) || 0,
	};
}

const shell = env.HONEYCRISP_SHELL === '1';
const host = await createFolderHost({
	root,
	token,
	uiDist:
		env.HONEYCRISP_UI_DIST || join(import.meta.dir, '..', 'build-desktop'),
	faults,
	pageToken,
	toShell: shell
		? (message) => console.log(JSON.stringify(message))
		: undefined,
});

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: Number(env.HONEYCRISP_HOST_PORT) || 0,
	// The event stream stays open for the life of the page.
	idleTimeout: 0,
	fetch: host.fetch,
});
const origin = `http://127.0.0.1:${server.port}`;
host.bind(origin);
console.log(
	JSON.stringify({ ready: true, port: server.port, root: host.root }),
);
if (!shell) console.error(`Honeycrisp folder host: ${origin}  (${host.root})`);

async function stop() {
	await server.stop(true);
	await host.close();
	process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);

if (shell) {
	// The shell holds stdin open. When it closes, the shell is gone.
	const decoder = new TextDecoder();
	let pending = '';
	const reader = Bun.stdin.stream().getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });
		let end = pending.indexOf('\n');
		while (end >= 0) {
			if (pending.slice(0, end).trim() === 'close-requested')
				host.closeRequested();
			pending = pending.slice(end + 1);
			end = pending.indexOf('\n');
		}
	}
	await stop();
}
