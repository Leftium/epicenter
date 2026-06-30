/**
 * `epicenter daemon up`: start the long-lived foreground daemon for one Epicenter root.
 *
 * Loads the mount declared in `epicenter.config.ts`, opens it, and exposes a
 * Unix-socket IPC channel for that root. `peers`, `list`, and `run` dispatch to
 * this daemon over IPC; without `daemon up` they error with a hint pointing
 * back here.
 *
 * One daemon per Epicenter root; one folder declares one mount. Resource
 * isolation between apps is expressed by separate folders, each its own root.
 *
 * Foreground by design; backgrounding is the user's job.
 */

import { realpathSync } from 'node:fs';
import type { SyncAuthClient } from '@epicenter/auth';
import {
	type MachineAuthStorageError,
	resolveMachineAuthClient,
} from '@epicenter/auth/node';
import type { StartedMount } from '@epicenter/workspace/daemon';
import {
	claimDaemonLease,
	createRelayChannelTransport,
	type DaemonMetadata,
	type DaemonServedDeviceGateway,
	DEFAULT_DEVICE_ROUTES,
	type EpicenterConfigError,
	exposedRoutesByKind,
	type InactiveMount,
	openAccountRoom,
	openEpicenterRoot,
	openRelayAcceptor,
	type RouteTable,
	StartupError,
	startDaemonServer,
	unlinkMetadata,
	withRelayExposed,
	type WorkspaceAppError,
	writeMetadata,
} from '@epicenter/workspace/node';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';

const CLI_VERSION = packageJson.version;

/**
 * Sync-status / presence lines write directly to stderr so they reach the
 * operator regardless of `--quiet`; the brief calls these out as "print
 * regardless of --quiet". `--quiet` only suppresses peer join/leave lines
 * (handled at their call sites), not these.
 */
function logSyncStatus(message: string): void {
	process.stderr.write(`${message}\n`);
}

/** A wire-safe route name (matched literally by the remote acceptor and on the wire). */
const RELAY_ROUTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Parse one `--relay-service <name>=<port>` flag value into a service-route spec.
 * Loopback is the design (the daemon dials `127.0.0.1:<port>`; the cross-device
 * hop is the relay floor, so the service box runs the daemon), so the grammar
 * carries no host: `<host>:<port>` is the seam to add the day a non-co-located
 * producer exists. Returns the offending reason on a malformed value; the handler
 * fails fast on it so a typo never starts a daemon with a route it cannot serve.
 */
export function parseRelayServiceFlag(
	spec: string,
): Result<{ name: string; port: number }, string> {
	const separator = spec.indexOf('=');
	if (separator === -1) return Err(`expected "<name>=<port>" (got "${spec}")`);
	const name = spec.slice(0, separator);
	const portText = spec.slice(separator + 1);
	if (!RELAY_ROUTE_NAME_PATTERN.test(name)) {
		return Err(
			`invalid route name "${name}": use letters, numbers, "_" or "-", starting with a letter or number`,
		);
	}
	if (!/^\d+$/.test(portText)) {
		return Err(`invalid port "${portText}" for route "${name}": expected digits`);
	}
	const port = Number(portText);
	if (port < 1 || port > 65535) {
		return Err(`port ${port} for route "${name}" is out of range (1-65535)`);
	}
	return Ok({ name, port });
}

type UpOptions = {
	/**
	 * The Epicenter root (the app folder that holds `epicenter.config.ts`). The
	 * yargs `-C` option
	 * resolves discovery (walking up to the nearest `epicenter.config.ts`) before
	 * the handler runs; direct callers pass the root they already know.
	 */
	epicenterRoot: string;
	quiet: boolean;
	cliVersion?: string;
	/**
	 * Factory that constructs the daemon's auth client. Production uses the
	 * default (`resolveMachineAuthClient`, which picks the instance-token client
	 * when a static token is configured via `EPICENTER_TOKEN` /
	 * `EPICENTER_TOKEN_FILE`, else reads the persisted OAuth cell from disk).
	 * Tests pass a stub or a deliberately-failing factory to exercise the
	 * auth-construction seam without seeding files or mutating env vars.
	 */
	createAuthClient?: () => Promise<
		Result<SyncAuthClient, MachineAuthStorageError>
	>;
	/**
	 * Route names to expose over the relay floor (default refused). Opts a route in
	 * knowingly, accepting the floor's trusted-relay ceiling; used for a two-machine
	 * smoke or by a self-hoster who runs their own relay.
	 */
	relayExpose?: string[];
	/**
	 * Local HTTP services to expose over the relay floor as service routes, each
	 * `{ name, port }`. Declaring one IS the opt-in (it is exposed straightaway),
	 * and the daemon dials it on loopback (`127.0.0.1:<port>`): the cross-device hop
	 * is the relay floor, so the service box runs the daemon. The handler parses the
	 * `--relay-service <name>=<port>` flag into these via {@link parseRelayServiceFlag}.
	 */
	relayService?: { name: string; port: number }[];
};

/**
 * Handle returned by {@link runUp}. The daemon body is exposed as a
 * standalone async function (no `process.exit`) so unit tests can drive
 * startup, exercise the IPC handler in-process, and call `teardown()` to
 * release resources without spawning a child. Inactive handles exist only so
 * tests and the command handler can report the reason and release the startup
 * lease; they are not running daemons.
 *
 * - `opened` is the single configured mount, either served (`started`) or
 *   reported (`inactive`) when it declined to run.
 * - `metadata` is the daemon metadata for this startup; it is written only
 *   when the mount actually starts and binds a socket.
 * - `teardown()` closes the server, asyncDisposes the runtimes, releases the
 *   lease, and unlinks metadata + socket. Idempotent.
 */
type UpHandle = {
	opened:
		| { status: 'started'; entry: StartedMount }
		| { status: 'inactive'; entry: InactiveMount };
	metadata: DaemonMetadata;
	teardown: () => Promise<void>;
};

/**
 * Daemon body. Opens the configured mount (the root must already have an
 * `epicenter.config.ts`; see `epicenter init`), binds the IPC socket for an
 * active mount, and returns a handle. The yargs `handler` calls this, prints
 * the operator-facing banner, installs SIGINT/SIGTERM, and parks the process
 * only when the mount started; tests call it directly and assert on the
 * returned handle.
 *
 * A SQLite daemon lease serializes startup before the mount opens. After that,
 * `openEpicenterRoot` imports `epicenter.config.ts`, claims the Epicenter
 * folder, opens the mount, and `startDaemonServer` binds the socket.
 */
export async function runUp(
	options: UpOptions,
): Promise<
	Result<
		UpHandle,
		| EpicenterConfigError
		| WorkspaceAppError
		| StartupError
		| MachineAuthStorageError
	>
> {
	const epicenterRoot = realpathSync(options.epicenterRoot);

	const leaseResult = claimDaemonLease(epicenterRoot);
	if (leaseResult.error !== null) return leaseResult;
	const lease = leaseResult.data;

	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: epicenterRoot,
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? CLI_VERSION,
	};

	// Ordered unwinding for partially-completed startup. Each resource
	// registers its disposer as it is acquired; `AsyncDisposableStack` runs
	// them in reverse. On any early `return` or `throw` before `stack.move()`,
	// `await using` disposes exactly what was acquired. On success, `move()`
	// transfers the stack to the caller as the returned `teardown`.
	await using stack = new AsyncDisposableStack();
	stack.defer(() => lease.release());

	// Load the machine auth client up front. A signed-out machine ("no saved
	// session") is a valid state: the daemon still serves local mounts and
	// reports session-only mounts as inactive, so it maps to a `null` session.
	// Any other storage error is fatal.
	const createAuthClient = options.createAuthClient ?? resolveMachineAuthClient;
	const authResult = await createAuthClient();
	let auth: SyncAuthClient | null = null;
	if (authResult.error) {
		if (authResult.error.name !== 'NoSavedSession')
			return Err(authResult.error);
	} else {
		const client = authResult.data;
		auth = client;
		stack.defer(() => client[Symbol.dispose]());
	}

	const startResult = await openEpicenterRoot({ epicenterRoot, auth });
	if (startResult.error) return startResult;
	const opened = startResult.data;

	// The served route table, with any `--relay-expose` routes opted in to the
	// floor. The default exposes nothing over the relay until a route opts in with
	// `relay: 'exposed'`. Computed before the account room opens so the daemon can
	// advertise its exposed routes in presence (floor discovery: the user's other
	// devices read this and auto-mount spawn routes or forward service routes).
	const exposedTable = options.relayExpose?.length
		? withRelayExposed(DEFAULT_DEVICE_ROUTES, options.relayExpose)
		: DEFAULT_DEVICE_ROUTES;
	// Operator-declared service routes are exposed by the act of declaring them (the
	// `--relay-service` flag IS the opt-in) and dial loopback only; they ride the
	// floor as a second vocabulary (HTTP, reached through a localhost forward), not
	// MCP. A name colliding with a default route replaces it (last wins).
	const serviceRoutes: RouteTable = {};
	for (const { name, port } of options.relayService ?? []) {
		serviceRoutes[name] = { kind: 'service', service: { port }, relay: 'exposed' };
	}
	const routes: RouteTable = { ...exposedTable, ...serviceRoutes };
	// Split the exposed routes by kind so presence advertises each vocabulary in its
	// own bucket: spawn routes a peer auto-mounts as MCP, service routes a peer
	// forwards. The split is what stops a consumer's MCP auto-mount from mis-dialing
	// a service route as MCP.
	const { spawn: exposedRoutes, service: exposedServices } =
		exposedRoutesByKind(routes);

	// Open the per-person account room alongside the mount: it holds the relay
	// floor's connection (its live presence and the channel port), not per-room
	// workspace presence. It is best-effort and independent of the mount: a
	// signed-out daemon has none (null), and a failure to open it never aborts the
	// mount that is the daemon's real job. Opened before the socket binds so its
	// presence can back `/relay-peers`, and deferred before the socket/runtime
	// below, so on LIFO teardown it disposes AFTER the socket closes: no in-flight
	// `/relay-peers` read can race a torn-down connection.
	const { data: accountRoom, error: accountRoomError } = await tryAsync({
		try: () =>
			openAccountRoom({ epicenterRoot, auth, exposedRoutes, exposedServices }),
		catch: (cause) => Err(extractErrorMessage(cause)),
	});
	if (accountRoomError !== null) {
		logSyncStatus(
			`account room: failed to open (${accountRoomError}); continuing`,
		);
	} else if (accountRoom !== null) {
		stack.defer(() => accountRoom[Symbol.asyncDispose]());
		logSyncStatus(`account room: online as ${accountRoom.nodeId}`);
	}

	// Wire the relay floor over the account-room socket: this device both DIALS its
	// peers and ACCEPTS inbound channels over the one per-user authenticated
	// connection the account room already holds. Both need a present account room
	// (a signed-in session), so a signed-out daemon has neither. The dial transport
	// is threaded into the daemon socket app so `tools`/`call` reach a peer over the
	// relay; the acceptor serves this device's relay-exposed routes back. Deferred
	// AFTER the account room so LIFO teardown closes them BEFORE the socket they
	// ride goes away.
	let deviceGateway: DaemonServedDeviceGateway | undefined;
	if (accountRoom !== null) {
		const dialTransport = createRelayChannelTransport(accountRoom.channelPort);
		stack.defer(() => dialTransport.close());
		deviceGateway = { transport: dialTransport };

		const relayAcceptor = openRelayAcceptor({
			channelPort: accountRoom.channelPort,
			routes,
			ownerUserId: accountRoom.ownerId,
		});
		stack.defer(() => relayAcceptor.close());

		logSyncStatus(
			`relay floor: online [routes: ${Object.keys(routes).join(', ') || 'none'}; exposed MCP: ${exposedRoutes.join(', ') || 'none'}; exposed services: ${exposedServices.join(', ') || 'none'}]`,
		);
	}

	if (opened.status === 'started') {
		const started = opened.entry;
		stack.defer(async () => {
			await started.runtime[Symbol.asyncDispose]();
		});

		const serverResult = await startDaemonServer({
			lease,
			mount: started,
			accountRoom: accountRoom ?? undefined,
			deviceGateway,
		});
		if (serverResult.error) return serverResult;
		const daemonServer = serverResult.data;
		stack.defer(() => daemonServer.close());
	}

	if (opened.status === 'started') {
		const metadataResult = trySync({
			try: () => writeMetadata(epicenterRoot, metadata),
			catch: (cause) => StartupError.MetadataWriteFailed({ cause }),
		});
		if (metadataResult.error) return metadataResult;
		stack.defer(() => unlinkMetadata(epicenterRoot));
	}

	const teardownStack = stack.move();
	return Ok({
		opened,
		metadata,
		teardown: () => teardownStack.disposeAsync(),
	});
}

/**
 * Yargs `daemon up` command. Thin glue: parses argv, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, exits after reporting
 * inactive mounts, or wires SIGINT/SIGTERM and parks until a signal triggers
 * teardown for active mounts.
 */
export const upCommand = cmd({
	command: 'up',
	describe:
		'Open the mount in epicenter.config.ts and serve it on the daemon socket (foreground).',
	builder: {
		C: epicenterRootOption,
		quiet: {
			type: 'boolean',
			default: false,
			description:
				'Suppress peer join/leave lines (sync state changes still print)',
		},
		'relay-expose': {
			type: 'array',
			string: true,
			description:
				'Route names to expose over the relay floor (default refused); accepts the trusted-relay ceiling',
		},
		'relay-service': {
			type: 'array',
			string: true,
			description:
				'Expose a local HTTP service over the relay floor as "<name>=<port>" (loopback; declaring it is the opt-in)',
		},
	},
	handler: async (argv) => {
		const options: UpOptions = {
			epicenterRoot: argv.C,
			quiet: argv.quiet,
			...(argv['relay-expose'] !== undefined && {
				relayExpose: argv['relay-expose'] as string[],
			}),
		};

		const relayServiceSpecs = argv['relay-service'] as string[] | undefined;
		if (relayServiceSpecs?.length) {
			const parsed: { name: string; port: number }[] = [];
			for (const spec of relayServiceSpecs) {
				const { data, error } = parseRelayServiceFlag(spec);
				if (error !== null) {
					process.stderr.write(`--relay-service: ${error}\n`);
					process.exit(1);
				}
				parsed.push(data);
			}
			options.relayService = parsed;
		}

		const { data: handle, error } = await runUp(options);
		if (error) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}

		if (handle.opened.status === 'inactive') {
			const declined = handle.opened.entry;
			logSyncStatus(`${declined.mount}: inactive (${declined.reason})`);
			await handle.teardown();
			return;
		} else {
			const entry = handle.opened.entry;
			logSyncStatus(`online (${entry.mount})`);
			monitorMount(entry, { quiet: options.quiet });
		}

		const onSignal = () => {
			void handle.teardown().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);

		// Park: don't exit. SIGINT/SIGTERM handler clears stdin so node can drain.
		process.stdin.resume();
	},
});

/**
 * Reports one mount's live collaboration over stderr: an initial peer
 * snapshot, then subscriptions for peer join/leave and sync status changes.
 * No-op when the mount has no collaboration channel. These three always run
 * together as one unit, so they share a single guard and `mount` binding.
 */
function monitorMount(
	{ mount, runtime }: StartedMount,
	{ quiet }: { quiet: boolean },
): void {
	const collaboration = runtime.collaboration;
	if (!collaboration) return;

	// Initial peer snapshot.
	const peers = collaboration.peers.list();
	if (peers.length === 0) {
		process.stderr.write(`${mount}: no peers connected\n`);
	} else {
		for (const peer of peers) {
			process.stderr.write(`${mount}: peer ${peer.nodeId}\n`);
		}
	}

	// Peer join/leave.
	let prev = new Set(peers.map((peer) => peer.nodeId));
	collaboration.peers.subscribe(() => {
		const next = new Set(collaboration.peers.list().map((peer) => peer.nodeId));
		for (const nodeId of next) {
			if (!prev.has(nodeId) && !quiet) {
				process.stderr.write(`${mount}: ${nodeId} joined\n`);
			}
		}
		for (const nodeId of prev) {
			if (!next.has(nodeId) && !quiet) {
				process.stderr.write(`${mount}: ${nodeId} left\n`);
			}
		}
		prev = next;
	});

	// Sync status.
	collaboration.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${mount}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${mount}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${mount}: offline`);
		}
	});
}
