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
 *   3. Construct machine auth only when a configured mount is collaborative.
 *      Local-only roots start without Epicenter auth.
 *   4. Claim the Epicenter folder's generated-state boundary.
 *   5. Build a per-mount context and run every `open(ctx)` in parallel.
 *      If any open fails, dispose the successfully opened runtimes before
 *      returning the first failure as a structured error.
 *
 * The host owns auth lifecycle. Local mounts receive only local Epicenter-root
 * identity. Collaborative mounts additionally receive the lazy `keyring` reader
 * (with a sign-out guard) plus the auth-derived function refs (`openWebSocket`,
 * `onReconnectSignal`) they forward into `openCollaboration`. Config-discovery
 * errors, host auth errors, and startup errors flow back as one `Result` union.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Keyring } from '@epicenter/encryption';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	type EpicenterConfigError,
	loadEpicenterConfig,
} from '../config/load-epicenter-config.js';
import type {
	CollaborativeMount,
	CollaborativeMountContext,
	LocalMountContext,
	Mount,
} from '../daemon/define-mount.js';
import { validateMountNames } from '../daemon/mount-validation.js';
import type { StartedMount } from '../daemon/types.js';
import { asDeviceId } from '../document/device-id.js';
import { mountMarkdownPath } from '../document/workspace-paths.js';
import { hashYDocClientId } from '../shared/client-id.js';
import type { EpicenterRoot } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import { WorkspaceAppError } from './errors.js';

type SignedInAuthClient = WorkspaceAuthClient & {
	state: Exclude<WorkspaceAuthClient['state'], { status: 'signed-out' }>;
};

export type OpenEpicenterRootOptions<TAuthError = never> = {
	epicenterRoot: EpicenterRoot | string;
	loadAuth?: () => Promise<Result<WorkspaceAuthClient | null, TAuthError>>;
};

/**
 * Bring an Epicenter root's daemon online: import its config, then open every
 * mount it declares. Returns the started mounts or the first config/startup
 * error.
 *
 * Opens run in parallel because each mount owns its own resources. If any open
 * fails, every successfully opened runtime is disposed before returning the
 * first failure.
 */
export async function openEpicenterRoot<TAuthError = never>(
	options: OpenEpicenterRootOptions<TAuthError>,
): Promise<
	Result<StartedMount[], EpicenterConfigError | WorkspaceAppError | TAuthError>
> {
	const epicenterRoot = resolve(options.epicenterRoot) as EpicenterRoot;

	const { data: mounts, error: configError } =
		await loadEpicenterConfig(epicenterRoot);
	if (configError !== null) return Err(configError);

	const issue = validateMountNames(mounts.map((mount) => mount.name));
	if (issue !== null) {
		return WorkspaceAppError.MountRejected(issue);
	}

	// Decide auth before any filesystem mutation. Local-only roots skip auth;
	// a collaborative mount without usable auth fails here, before the folder
	// claim writes generated-state markers.
	const collaborativeMounts = mounts.filter(isCollaborativeMount);
	const authResult = await loadAuthIfNeeded({
		loadAuth: options.loadAuth,
		collaborativeMounts,
	});
	if (authResult.error) return Err(authResult.error);
	const auth = authResult.data;

	const populated = findPopulatedMountFolder(epicenterRoot, mounts);
	if (populated !== null) {
		return WorkspaceAppError.MountFolderNotEmpty(populated);
	}

	const claimResult = trySync({
		try: () => claimEpicenterFolder(epicenterRoot),
		catch: (cause) =>
			WorkspaceAppError.EpicenterFolderClaimFailed({
				epicenterRoot,
				cause,
			}),
	});
	if (claimResult.error !== null) return Err(claimResult.error);

	const settled = await Promise.allSettled(
		mounts.map((mount) => openOneMount({ mount, epicenterRoot, auth })),
	);

	const opened: StartedMount[] = [];
	let firstError: WorkspaceAppError | null = null;

	for (const result of settled) {
		if (result.status !== 'fulfilled') {
			if (firstError === null) {
				firstError = WorkspaceAppError.MountOpenFailed({
					mount: '<unknown>',
					cause: result.reason,
				}).error;
			}
			continue;
		}
		const value = result.value;
		if (value.error) {
			if (firstError === null) firstError = value.error;
			continue;
		}
		opened.push(value.data);
	}

	if (firstError !== null) {
		await disposeOpenedRuntimes(opened);
		return Err(firstError);
	}

	return Ok(opened);
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
 * OS bookkeeping files (`.DS_Store`, `Thumbs.db`) do not count as content: a
 * folder a user merely browsed in Finder is not "populated by hand," and
 * refusing to start over a `.DS_Store` would be a baffling macOS footgun.
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
 * keeps `.epicenter/` a trustworthy "already claimed" marker: once it exists,
 * either the root ignore already exists or the user had their own ignore file
 * that Epicenter must not overwrite.
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

async function openOneMount({
	mount,
	epicenterRoot,
	auth,
}: {
	mount: Mount;
	epicenterRoot: EpicenterRoot;
	auth: SignedInAuthClient | null;
}): Promise<Result<StartedMount, WorkspaceAppError>> {
	const baseContext = {
		epicenterRoot,
		mount: mount.name,
	} satisfies LocalMountContext;
	try {
		if (mount.kind === 'local') {
			const runtime = await mount.open(baseContext);
			if (runtime.collaboration !== undefined) {
				await Promise.resolve(runtime[Symbol.asyncDispose]()).catch(
					() => undefined,
				);
				return WorkspaceAppError.MountOpenFailed({
					mount: mount.name,
					cause: new Error(
						`Local mount "${mount.name}" returned collaboration. Declare kind: "collaborative" to serve peer sync.`,
					),
				});
			}
			return Ok({ mount: mount.name, runtime });
		}

		const authRequired = requireMountAuth({ auth, mounts: [mount.name] });
		if (authRequired.error) return authRequired;
		const collaborativeAuth = authRequired.data;

		const ctx = {
			...baseContext,
			yDocClientId: hashYDocClientId(epicenterRoot),
			deviceId: asDeviceId(`${mount.name}-daemon`),
			ownerId: collaborativeAuth.state.ownerId,
			keyring: createMountKeyringReader({
				auth: collaborativeAuth,
				mount: mount.name,
			}),
			// `auth.openWebSocket` / `auth.fetch` / `auth.onStateChange` are
			// closure-based on the auth client and do not read `this`, so passing the
			// method reference directly is safe (no `.bind(auth)` needed).
			openWebSocket: collaborativeAuth.openWebSocket,
			fetch: collaborativeAuth.fetch,
			onReconnectSignal: collaborativeAuth.onStateChange,
		} satisfies CollaborativeMountContext;
		const runtime = await mount.open(ctx);
		return Ok({ mount: mount.name, runtime });
	} catch (cause) {
		return WorkspaceAppError.MountOpenFailed({
			mount: mount.name,
			cause,
		});
	}
}

async function loadAuthIfNeeded<TAuthError>({
	loadAuth,
	collaborativeMounts,
}: {
	loadAuth?: () => Promise<Result<WorkspaceAuthClient | null, TAuthError>>;
	collaborativeMounts: CollaborativeMount[];
}): Promise<Result<SignedInAuthClient | null, WorkspaceAppError | TAuthError>> {
	if (collaborativeMounts.length === 0) return Ok(null);
	const result = loadAuth ? await loadAuth() : Ok(null);
	if (result.error) return Err(result.error);
	return requireMountAuth({
		auth: result.data,
		mounts: collaborativeMounts.map((mount) => mount.name),
	});
}

function isCollaborativeMount(mount: Mount): mount is CollaborativeMount {
	return mount.kind === 'collaborative';
}

function requireMountAuth({
	auth,
	mounts,
}: {
	auth: WorkspaceAuthClient | null;
	mounts: string[];
}): Result<SignedInAuthClient, WorkspaceAppError> {
	if (!hasSignedInAuth(auth)) {
		return WorkspaceAppError.MountAuthRequired({ mounts });
	}
	return Ok(auth);
}

function hasSignedInAuth(
	auth: WorkspaceAuthClient | null,
): auth is SignedInAuthClient {
	return auth !== null && auth.state.status !== 'signed-out';
}

/**
 * Build the lazy keyring reader the mount ctx hands to factories. Reads
 * `auth.state` on every call so a late sign-out throws at the next encrypted
 * write or registration site instead of the host having to re-check on every
 * open.
 */
function createMountKeyringReader({
	auth,
	mount,
}: {
	auth: WorkspaceAuthClient;
	mount: string;
}): () => Keyring {
	return () => {
		if (auth.state.status === 'signed-out') {
			throw new Error(`[${mount}-daemon] auth signed-out.`);
		}
		return auth.state.keyring;
	};
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
