/**
 * Twenty actual Tauri restarts with production Bun launch/shutdown and
 * admitted-window paths. Each restart is a departure grant finished by the
 * `relaunch` frame, so it runs `request_restart`; every exit must reach the
 * Folder plugin's shutdown. The first process also drives two departure
 * rounds through Capture- and Todos-labelled windows: a grant and its abort
 * with Todos closed beforehand, and a native discard followed by Bun's
 * withdrawal. The rounds are driven natively; Bun's own preparation is covered
 * by the controlled port and authority tests. On macOS every process installs
 * the quit guard, the last one leaves through `[NSApp terminate:]`, refused
 * once and then agreed, and a separate process with no participant window
 * terminates through AppKit as before. Uses a unique native identity
 * and temporary App data. No real account is read. Run from the repository
 * root with Bun.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = new URL('../../../', import.meta.url).pathname;
const root = await mkdtemp(join(tmpdir(), 'epicenter-runtime-evidence-'));
const identifier = `so.epicenter.evidence.${crypto.randomUUID()}`;
const binary = resolve(
	repo,
	'apps/epicenter/src-tauri/target/debug/examples/runtime_lifetime_evidence',
);
type Event = {
	event: string;
	pid?: number;
	cycle?: number;
	error?: string;
	sidecarDead?: boolean;
	folderFenced?: boolean;
	restartRequested?: boolean;
	passed?: boolean;
	globalNudgeReachedTodos?: boolean;
	run?: 'cycles' | 'terminate-now';
	code?: number | null;
	prevented?: boolean;
	draftKept?: boolean;
	terminateReplies?: string[];
};
let events: Event[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
let terminating: ReturnType<typeof Bun.spawn> | undefined;
async function readEvents() {
	const contents = await readFile(join(root, 'events.jsonl'), 'utf8').catch(
		() => '',
	);
	// The producer can be halfway through its final append while we read.
	events = contents
		.slice(0, contents.lastIndexOf('\n') + 1)
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const failure = events.find((event) => event.event === 'failure');
	if (failure) throw new Error(failure.error);
}
const inRun = (run: Event['run'], name: string) =>
	events.filter((event) => event.run === run && event.event === name);
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
try {
	const bundle = join(root, 'data/apps/so.epicenter.runtimeevidence/bundle');
	await mkdir(bundle, { recursive: true });
	await writeFile(join(root, 'identifier'), identifier);
	await writeFile(
		join(root, 'website-store'),
		crypto.getRandomValues(new Uint8Array(16)),
	);
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { data() {} },
	});
	const port = listener.port;
	listener.stop(true);
	await writeFile(join(root, 'port'), String(port));
	await writeFile(
		join(bundle, 'manifest.json'),
		JSON.stringify({
			id: 'so.epicenter.runtimeevidence',
			title: 'Runtime evidence',
			version: '1',
		}),
	);
	const built = await Bun.build({
		entrypoints: [
			join(repo, 'apps/epicenter/evidence/runtime-lifetime/main.ts'),
		],
		outdir: bundle,
		target: 'browser',
		conditions: ['browser'],
		naming: 'main.js',
	});
	if (!built.success)
		throw new AggregateError(built.logs, 'Evidence fixture build failed');
	await writeFile(
		join(bundle, 'index.html'),
		'<!doctype html><html><body>Runtime lifetime evidence<script type="module" src="./main.js"></script></body></html>',
	);
	const build = Bun.spawn(
		[
			'cargo',
			'build',
			'--manifest-path',
			'apps/epicenter/src-tauri/Cargo.toml',
			'--features',
			'runtime-evidence',
			'--example',
			'runtime_lifetime_evidence',
		],
		{ cwd: repo, stdout: 'inherit', stderr: 'inherit' },
	);
	if (await build.exited) throw new Error('Native evidence build failed');
	child = Bun.spawn([binary], {
		cwd: repo,
		env: { ...process.env, EPICENTER_RUNTIME_EVIDENCE_ROOT: root },
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const deadline = Date.now() + 180_000;
	for (;;) {
		await Bun.sleep(100);
		await readEvents();
		if (inRun('cycles', 'shutdown').length === 21) break;
		if (Date.now() > deadline)
			throw new Error(
				`Native restart probe timed out: ${JSON.stringify(events.at(-1))}`,
			);
	}
	const chainExit = await child.exited;
	const hosts = inRun('cycles', 'host');
	const sidecars = inRun('cycles', 'sidecar');
	const documents = inRun('cycles', 'document');
	if (
		hosts.length !== 21 ||
		sidecars.length !== 21 ||
		documents.length !== 41 ||
		new Set(hosts.map((event) => event.pid)).size !== 21 ||
		!events.some((event) => event.event === 'passed')
	)
		throw new Error('Missing restart evidence');
	for (const event of [...hosts, ...sidecars])
		if (event.pid && alive(event.pid))
			throw new Error(`Probe process ${event.pid} survived`);
	const shutdowns = inRun('cycles', 'shutdown');
	if (!shutdowns.every((event) => event.folderFenced))
		throw new Error('An exit did not reach the Folder plugin shutdown');
	if (shutdowns.filter((event) => event.restartRequested).length !== 20)
		throw new Error('Not every restart went through the granted relaunch');
	const probes = inRun('cycles', 'departure-probe');
	if (probes.length !== 1 || !probes[0]?.passed)
		throw new Error('Missing departure probe evidence');

	if (process.platform === 'darwin') {
		// Every process installed the quit guard on Tao's own delegate.
		if (inRun('cycles', 'terminate-guard').length !== 21)
			throw new Error('A process ran without the quit guard');
		// The last process left through two `terminate:` calls: the first was
		// refused into a quit round Capture cancelled with its draft kept, the
		// second was agreed by both pages and left through one Exit.
		const last = (name: string) =>
			inRun('cycles', name).filter((event) => event.cycle === 20);
		const requests = last('exit-requested');
		if (
			chainExit !== 0 ||
			last('terminate-cancelled').length !== 1 ||
			!last('terminate-cancelled')[0]?.draftKept ||
			requests.length !== 3 ||
			requests.some((event) => event.code !== 0) ||
			requests.map((event) => event.prevented).join() !== 'true,true,false' ||
			last('shutdown').length !== 1 ||
			!last('shutdown')[0]?.folderFenced ||
			!last('shutdown')[0]?.sidecarDead ||
			// Two refusals, and none while leaving.
			last('shutdown')[0]?.terminateReplies?.join() !==
				'cancel-and-quit,cancel-and-quit'
		)
			throw new Error(
				`AppKit terminate evidence is wrong: exit ${chainExit}, ${JSON.stringify(requests)}, replies ${JSON.stringify(last('shutdown')[0]?.terminateReplies)}`,
			);

		// With no participant window, AppKit terminates as it always has:
		// through Exit, with no exit request.
		terminating = Bun.spawn([binary], {
			cwd: repo,
			env: {
				...process.env,
				EPICENTER_RUNTIME_EVIDENCE_ROOT: root,
				EPICENTER_RUNTIME_EVIDENCE_TERMINATE_NOW: '1',
			},
			stdout: 'inherit',
			stderr: 'inherit',
		});
		const timeout = setTimeout(() => terminating?.kill('SIGKILL'), 60_000);
		const terminateExit = await terminating.exited;
		clearTimeout(timeout);
		await readEvents();
		const run = (name: string) => inRun('terminate-now', name);
		if (
			terminateExit !== 0 ||
			run('terminate-guard').length !== 1 ||
			run('terminate-now-requested').length !== 1 ||
			run('exit-requested').length !== 0 ||
			run('shutdown').length !== 1 ||
			!run('shutdown')[0]?.folderFenced ||
			!run('shutdown')[0]?.sidecarDead ||
			run('shutdown')[0]?.terminateReplies?.join() !== 'now'
		)
			throw new Error(
				`AppKit terminate without participants is wrong: exit ${terminateExit}, ${JSON.stringify(run('shutdown')[0] ?? null)}`,
			);
		for (const event of [...run('host'), ...run('sidecar')])
			if (event.pid && alive(event.pid))
				throw new Error(`Probe process ${event.pid} survived`);
		console.log(
			'PASS: AppKit terminate: the quit guard was installed on the same Tao delegate in every process; with participant windows it was refused into a quit round that Capture cancelled with its page and draft intact, then agreed by both pages and left through one Exit with the Folder fenced and Bun stopped; with none, AppKit terminated through Exit with no exit request.',
		);
	}
	console.log(
		'PASS: 20 actual native restarts through granted relaunch and request_restart, 20 immediate admitted-window reopens, all committed App markers survived, every exit fenced the Folder plugin, all 21 native hosts and Bun sidecars terminated.',
	);
	console.log(
		`PASS: departure probe: page-load generation before the first read, window-scoped nudge targeted, participant windows out of the AppKit Window list, grant hid both windows (is_visible false) and refused the Window menu, abort restored Capture shown and Todos hidden, native discard hid Capture and the Window menu could not show it, Bun withdrawal restored both. Global listen heard the other label's nudge: ${probes[0].globalNudgeReachedTodos}. Not covered here: Bun's own prepare-relaunch, an in-flight Folder write drain, and physical input.`,
	);
} finally {
	let profileRemoved = true;
	for (const event of events)
		if (event.pid && alive(event.pid)) process.kill(event.pid, 'SIGKILL');
	for (const spawned of [child, terminating])
		if (spawned && spawned.exitCode === null && spawned.signalCode === null)
			spawned.kill('SIGKILL');
	await child?.exited;
	await terminating?.exited;
	if (child && process.platform === 'darwin') {
		const cleanup = Bun.spawn([binary], {
			cwd: repo,
			env: {
				...process.env,
				EPICENTER_RUNTIME_EVIDENCE_ROOT: root,
				EPICENTER_RUNTIME_EVIDENCE_CLEANUP: '1',
			},
			stdout: 'inherit',
			stderr: 'inherit',
		});
		const timeout = setTimeout(() => cleanup.kill('SIGKILL'), 10_000);
		try {
			if (await cleanup.exited) {
				profileRemoved = false;
				process.exitCode = 1;
				console.error(
					`Failed to remove isolated WebKit profile. Evidence root: ${root}`,
				);
			}
		} finally {
			clearTimeout(timeout);
		}
	}
	if (profileRemoved) await rm(root, { recursive: true, force: true });
	if (process.platform === 'darwin')
		for (const directory of ['WebKit', 'Caches', 'Logs', 'Application Support'])
			await rm(join(homedir(), 'Library', directory, identifier), {
				recursive: true,
				force: true,
			});
}
