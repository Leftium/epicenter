#!/usr/bin/env bun
/**
 * Entry point of the Whispering folder host.
 *
 * The desktop shell starts this process, reads one JSON line from its standard
 * output to learn the port, and loads the page from it. The host stops when
 * the shell closes its standard input, so it never outlives the window.
 *
 * Before the shell closes the window or quits, it writes
 * `{"type":"close-requested"}` to this process's standard input. The host asks
 * the page, and prints `{"closeApproved":true}` when the window may close.
 *
 * Configuration is the environment:
 *
 * - `WHISPERING_DATA_ROOT`: the data folder. Defaults to
 *   `~/Epicenter/local/so.epicenter.whispering`.
 * - `WHISPERING_HOST_TOKEN`: the per-launch credential. Generated when unset.
 * - `WHISPERING_UI_DIST`: the built page. Defaults to this app's `build/`.
 * - `WHISPERING_HOST_PORT`: a fixed port. Defaults to any free port.
 * - `WHISPERING_DEBUG=1`: set by a debug shell; allows fixture audio and
 *   failure injection.
 * - `WHISPERING_AUDIO_FIXTURE`: a file whose bytes answer every recording, in
 *   a debug shell only.
 * - `WHISPERING_HOST_STANDALONE=1`: run without the shell. The token is
 *   written into the served page and standard input is not watched.
 */
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost } from './host.js';

const env = process.env;
const standalone = env.WHISPERING_HOST_STANDALONE === '1';
const log = (message: string) => console.error(`[whispering-host] ${message}`);

const root = resolve(
	env.WHISPERING_DATA_ROOT?.trim() ||
		join(homedir(), 'Epicenter', 'local', 'so.epicenter.whispering'),
);
const token =
	env.WHISPERING_HOST_TOKEN || randomBytes(32).toString('base64url');

const host = await createHost({
	root,
	token,
	uiDist: env.WHISPERING_UI_DIST || join(import.meta.dir, '..', 'build'),
	debug: env.WHISPERING_DEBUG === '1',
	fixturePath: env.WHISPERING_AUDIO_FIXTURE?.trim() || undefined,
	inlineToken: standalone,
	env,
	log,
	// The shell reads this line and closes; nothing else may print it.
	onCloseApproved: () => console.log(JSON.stringify({ closeApproved: true })),
});

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: Number(env.WHISPERING_HOST_PORT ?? 0),
	// The event stream is long-lived; the host pings it well inside this limit.
	idleTimeout: 255,
	fetch: (request) => host.handle(request),
});
const port = server.port ?? 0;
host.listening(port);

let stopping = false;
async function stop(reason: string) {
	if (stopping) return;
	stopping = true;
	log(`Stopping: ${reason}`);
	await server.stop(true);
	await host.close().catch((cause) => log(`Close failed: ${String(cause)}`));
	process.exit(0);
}

process.on('SIGINT', () => void stop('interrupted'));
process.on('SIGTERM', () => void stop('terminated'));
if (!standalone) {
	// One JSON line per message from the shell. The only one is a close request.
	let buffered = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk: string) => {
		buffered += chunk;
		let newline = buffered.indexOf('\n');
		while (newline >= 0) {
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line.includes('"close-requested"')) host.closeRequested();
			newline = buffered.indexOf('\n');
		}
	});
	process.stdin.on('end', () => void stop('the shell closed'));
	process.stdin.on('close', () => void stop('the shell closed'));
	process.stdin.resume();
}

// The one line the shell waits for. Everything else goes to standard error.
console.log(JSON.stringify({ ready: true, port, root: host.root }));
if (standalone) log(`Serving ${host.root} at http://127.0.0.1:${port}/`);
