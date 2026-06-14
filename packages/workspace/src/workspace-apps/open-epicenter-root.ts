/**
 * Open an Epicenter root: the single daemon entry point from
 * `epicenter.config.ts` to the live mount runtime.
 *
 * `openEpicenterRoot()` is what `epicenter daemon up` calls. It owns the whole
 * startup path:
 *
 *   1. `loadEpicenterConfig(epicenterRoot)` imports `epicenter.config.ts` and
 *      validates that its default export is a single `Mount` with a valid name.
 *   2. Claim the Epicenter folder's generated-state boundary.
 *   3. Build the `MountSession` from the caller's auth client (or `null` when
 *      signed out: a logged-out daemon is a valid state), then open the mount
 *      with it.
 *
 * One folder declares one mount. The daemon never gates on auth: it receives an
 * auth client (or `null`) from the CLI, hands the mount the resulting
 * `session`, and lets the mount decide. A local mirror ignores it, a peer-plane
 * mount uses its socket, an encrypted-workspace mount uses its keyring or
 * returns `inactive("sign in ...")`. The mount either becomes `started` or is
 * reported `inactive`. Only a config error, a folder-claim failure, or a thrown
 * `open` aborts startup.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import {
	type EpicenterConfigError,
	loadEpicenterConfig,
} from '../config/load-epicenter-config.js';
import {
	isInactive,
	type Mount,
	type MountSession,
} from '../daemon/define-mount.js';
import type { StartedMount } from '../daemon/types.js';
import { mountMarkdownPath } from '../document/workspace-paths.js';
import type { EpicenterRoot } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import { WorkspaceAppError } from './errors.js';

/** The mount declined to start, with the reason it returned. */
export type InactiveMount = {
	mount: string;
	reason: string;
};

/** The outcome of opening a root: the mount either started or declined. */
export type OpenedMount =
	| { status: 'started'; entry: StartedMount }
	| { status: 'inactive'; entry: InactiveMount };

export type OpenEpicenterRootOptions = {
	epicenterRoot: EpicenterRoot | string;
	/**
	 * The machine auth client, or `null` when signed out (a valid, supported
	 * state). The CLI owns loading it and mapping "no saved session" to `null`;
	 * the daemon only reads its state to build the mount's `session`.
	 */
	auth: WorkspaceAuthClient | null;
};

/**
 * Bring an Epicenter root's daemon online: import its config, claim the folder,
 * then open the one mount it declares. Returns whether the mount started or
 * declined, or the config/startup error.
 */
export async function openEpicenterRoot(
	options: OpenEpicenterRootOptions,
): Promise<Result<OpenedMount, EpicenterConfigError | WorkspaceAppError>> {
	const epicenterRoot = resolve(options.epicenterRoot) as EpicenterRoot;

	const { data: mount, error: configError } =
		await loadEpicenterConfig(epicenterRoot);
	if (configError !== null) return Err(configError);

	const populated = findPopulatedMountFolder(epicenterRoot, mount);
	if (populated !== null) {
		return WorkspaceAppError.MountFolderNotEmpty(populated);
	}

	const claimResult = trySync({
		try: () => claimEpicenterFolder(epicenterRoot),
		catch: (cause) =>
			WorkspaceAppError.EpicenterFolderClaimFailed({ epicenterRoot, cause }),
	});
	if (claimResult.error !== null) return Err(claimResult.error);

	// The session carries only auth-derived capabilities. Per-mount identity
	// (clientID, device id) is derived from `epicenterRoot` / `mount` where it is
	// used, not pinned here.
	const session = buildMountSession(options.auth);

	const ctx = { epicenterRoot, mount: mount.name, session };
	const { data: result, error: openError } = await tryAsync({
		try: () => Promise.resolve(mount.open(ctx)),
		catch: (cause) =>
			WorkspaceAppError.MountOpenFailed({ mount: mount.name, cause }),
	});
	if (openError !== null) return Err(openError);

	if (isInactive(result)) {
		return Ok({
			status: 'inactive',
			entry: { mount: mount.name, reason: result.reason },
		});
	}
	return Ok({
		status: 'started',
		entry: { mount: mount.name, runtime: result },
	});
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
	mount: Mount,
): { mount: string; path: string } | null {
	const namespaceEstablished = existsSync(join(epicenterRoot, '.epicenter'));
	if (namespaceEstablished) return null;

	const path = mountMarkdownPath(epicenterRoot, mount.name);
	if (!existsSync(path)) return null;
	const isPopulated =
		!statSync(path).isDirectory() ||
		readdirSync(path).some((entry) => !IGNORED_BOOTSTRAP_ENTRIES.has(entry));
	return isPopulated ? { mount: mount.name, path } : null;
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
