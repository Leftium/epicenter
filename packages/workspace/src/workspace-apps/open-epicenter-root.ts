/**
 * Open an Epicenter root: the single daemon entry point from
 * `epicenter.config.ts` to live mount runtimes.
 *
 * `openEpicenterRoot()` is what `epicenter daemon up` calls. It owns the whole
 * startup path:
 *
 *   1. `loadEpicenterConfig(epicenterRoot)` imports `epicenter.config.ts` and
 *      validates that its default export is a `Mount[]`.
 *   2. Validate the configured mount names.
 *   3. Claim the Epicenter folder's generated-state boundary.
 *   4. Build one `MountSession` from the caller's auth client (or `null` when
 *      signed out: a logged-out daemon is a valid state), then open every mount
 *      with it.
 *
 * The daemon never gates on auth: it receives an auth client (or `null`) from
 * the CLI, hands each mount the resulting `session`, and lets the mount decide.
 * A local mirror ignores it, a peer-plane mount uses its socket, an
 * encrypted-workspace mount uses its keyring or returns `inactive("sign in
 * ...")`. Mounts that open become `started`; mounts that return `inactive` are
 * reported but do not block their siblings. Only a config error, a name
 * collision, a folder-claim failure, or a thrown `open` aborts startup.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	type EpicenterConfigError,
	loadEpicenterConfig,
} from '../config/load-epicenter-config.js';
import {
	isInactive,
	type Mount,
	type MountSession,
} from '../daemon/define-mount.js';
import { validateMountNames } from '../daemon/mount-validation.js';
import type { StartedMount } from '../daemon/types.js';
import { mountMarkdownPath } from '../document/workspace-paths.js';
import type { EpicenterRoot } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import { WorkspaceAppError } from './errors.js';

/** One mount that declined to start, with the reason it returned. */
export type InactiveMount = {
	mount: string;
	reason: string;
};

/** The outcome of opening a root: the mounts that started and the ones that did not. */
export type OpenedEpicenterRoot = {
	started: StartedMount[];
	inactive: InactiveMount[];
};

export type OpenEpicenterRootOptions = {
	epicenterRoot: EpicenterRoot | string;
	/**
	 * The machine auth client, or `null` when signed out (a valid, supported
	 * state). The CLI owns loading it and mapping "no saved session" to `null`;
	 * the daemon only reads its state to build each mount's `session`.
	 */
	auth: WorkspaceAuthClient | null;
};

type OpenOutcome =
	| { kind: 'started'; mount: StartedMount }
	| { kind: 'inactive'; mount: InactiveMount }
	| { kind: 'failed'; error: WorkspaceAppError };

/**
 * Bring an Epicenter root's daemon online: import its config, claim the folder,
 * then open every mount it declares. Returns the started and inactive mounts,
 * or the first config/startup error.
 *
 * Opens run in parallel because each mount owns its own resources. If any open
 * throws, every successfully opened runtime is disposed before returning the
 * first failure.
 */
export async function openEpicenterRoot(
	options: OpenEpicenterRootOptions,
): Promise<
	Result<OpenedEpicenterRoot, EpicenterConfigError | WorkspaceAppError>
> {
	const epicenterRoot = resolve(options.epicenterRoot) as EpicenterRoot;

	const { data: mounts, error: configError } =
		await loadEpicenterConfig(epicenterRoot);
	if (configError !== null) return Err(configError);

	const issue = validateMountNames(mounts.map((mount) => mount.name));
	if (issue !== null) {
		return WorkspaceAppError.MountRejected(issue);
	}

	const populated = findPopulatedMountFolder(epicenterRoot, mounts);
	if (populated !== null) {
		return WorkspaceAppError.MountFolderNotEmpty(populated);
	}

	const claimResult = trySync({
		try: () => claimEpicenterFolder(epicenterRoot),
		catch: (cause) =>
			WorkspaceAppError.EpicenterFolderClaimFailed({ epicenterRoot, cause }),
	});
	if (claimResult.error !== null) return Err(claimResult.error);

	// One session for the whole root: it carries only auth-derived capabilities,
	// so every mount shares it. Per-mount identity (clientID, device id) is
	// derived from `epicenterRoot` / `mount` where it is used, not pinned here.
	const session = buildMountSession(options.auth);

	const settled = await Promise.allSettled(
		mounts.map((mount) => openOneMount({ mount, epicenterRoot, session })),
	);

	const started: StartedMount[] = [];
	const inactive: InactiveMount[] = [];
	let firstError: WorkspaceAppError | null = null;

	for (const result of settled) {
		if (result.status !== 'fulfilled') {
			firstError ??= WorkspaceAppError.MountOpenFailed({
				mount: '<unknown>',
				cause: result.reason,
			}).error;
			continue;
		}
		const outcome = result.value;
		if (outcome.kind === 'failed') {
			firstError ??= outcome.error;
		} else if (outcome.kind === 'inactive') {
			inactive.push(outcome.mount);
		} else {
			started.push(outcome.mount);
		}
	}

	if (firstError !== null) {
		await disposeOpenedRuntimes(started);
		return Err(firstError);
	}

	return Ok({ started, inactive });
}

async function openOneMount({
	mount,
	epicenterRoot,
	session,
}: {
	mount: Mount;
	epicenterRoot: EpicenterRoot;
	session: MountSession | null;
}): Promise<OpenOutcome> {
	const ctx = { epicenterRoot, mount: mount.name, session };
	try {
		const result = await mount.open(ctx);
		if (isInactive(result)) {
			return {
				kind: 'inactive',
				mount: { mount: mount.name, reason: result.reason },
			};
		}
		return { kind: 'started', mount: { mount: mount.name, runtime: result } };
	} catch (cause) {
		return {
			kind: 'failed',
			error: WorkspaceAppError.MountOpenFailed({ mount: mount.name, cause })
				.error,
		};
	}
}

/**
 * Build the signed-in capability kit, or `null` when machine auth is absent or
 * signed out. The keyring reader re-checks `auth.state` on every call so a late
 * sign-out throws at the next encrypted write rather than silently losing
 * ciphertext.
 */
function buildMountSession(
	auth: WorkspaceAuthClient | null,
): MountSession | null {
	if (auth === null || auth.state.status === 'signed-out') return null;
	return {
		ownerId: auth.state.ownerId,
		keyring: () => {
			if (auth.state.status === 'signed-out') {
				throw new Error('Cannot read keyring: machine auth is signed out.');
			}
			return auth.state.keyring;
		},
		// `auth.openWebSocket` / `auth.fetch` / `auth.onStateChange` are
		// closure-based on the auth client and do not read `this`, so passing the
		// method reference directly is safe (no `.bind(auth)` needed).
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
		fetch: auth.fetch,
	};
}

/**
 * Bootstrap guard: refuse to claim a mount folder a user populated before the
 * namespace exists.
 *
 * `.epicenter/` is Epicenter's "this folder is mine" marker. Until it exists,
 * the namespace has not been established, so a non-empty `<root>/<mount>/` (a
 * direct child named after a declared mount) is the user's own data, not a
 * generated projection. Adopting it would let `markdown_rebuild` later sweep
 * those files. Once `.epicenter/` exists, the claim is about ownership, not
 * proof that a projection has already been generated: declared mount folders
 * are reserved for Epicenter to generate and rebuild, so this guard stands down.
 *
 * OS bookkeeping files (`.DS_Store`, `Thumbs.db`) do not count as content.
 *
 * Returns the first offending mount, or null when bootstrap is safe.
 */
const IGNORED_BOOTSTRAP_ENTRIES = new Set(['.DS_Store', 'Thumbs.db']);

const ROOT_GITIGNORE = `# Epicenter folder. Only epicenter.config.ts is tracked; the generated mount
# projections and the machine state under .epicenter/ are derived from the Yjs
# log and rebuilt on demand, so git ignores them.
/*
!/.gitignore
!/epicenter.config.ts
`;

function findPopulatedMountFolder(
	epicenterRoot: EpicenterRoot,
	mounts: readonly Mount[],
): { mount: string; path: string } | null {
	const namespaceEstablished = existsSync(join(epicenterRoot, '.epicenter'));
	if (namespaceEstablished) return null;

	for (const mount of mounts) {
		const path = mountMarkdownPath(epicenterRoot, mount.name);
		if (!existsSync(path)) continue;
		const isPopulated =
			!statSync(path).isDirectory() ||
			readdirSync(path).some((entry) => !IGNORED_BOOTSTRAP_ENTRIES.has(entry));
		if (isPopulated) return { mount: mount.name, path };
	}
	return null;
}

/**
 * Claim the folder before any mount can create generated state.
 *
 * Fresh namespaces get the root ignore first, then `.epicenter/`. That ordering
 * keeps `.epicenter/` a trustworthy "already claimed" marker.
 */
function claimEpicenterFolder(epicenterRoot: EpicenterRoot): void {
	const namespaceEstablished = existsSync(join(epicenterRoot, '.epicenter'));
	if (!namespaceEstablished) {
		const rootGitignorePath = join(epicenterRoot, '.gitignore');
		if (!existsSync(rootGitignorePath)) {
			writeFileSync(rootGitignorePath, ROOT_GITIGNORE);
		}
	}

	const epicenterDataDir = join(epicenterRoot, '.epicenter');
	mkdirSync(epicenterDataDir, { recursive: true, mode: 0o700 });
	const cacheGitignorePath = join(epicenterDataDir, '.gitignore');
	if (!existsSync(cacheGitignorePath)) {
		writeFileSync(cacheGitignorePath, '*\n', { mode: 0o600 });
	}
}

async function disposeOpenedRuntimes(
	runtimes: readonly StartedMount[],
): Promise<void> {
	await Promise.allSettled(
		runtimes.map((entry) =>
			Promise.resolve(entry.runtime[Symbol.asyncDispose]()),
		),
	);
}
