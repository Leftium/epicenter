/**
 * Open a project: the single daemon entry point from `epicenter.config.ts` to
 * live mount runtimes.
 *
 * `openProject()` is what `epicenter daemon up` calls. It owns the whole
 * startup path:
 *
 *   1. `loadProjectConfig(projectDir)` imports `epicenter.config.ts` and
 *      validates that its default export is a `Mount[]`.
 *   2. Validate the configured mount names.
 *   3. Construct machine auth only when a configured mount is collaborative.
 *   4. Build a per-mount context and run every `open(ctx)` in parallel.
 *      If any open fails, dispose the successfully opened runtimes before
 *      returning the first failure as a structured error.
 *
 * The host owns auth lifecycle. Local mounts receive only local project
 * identity. Collaborative mounts additionally receive the lazy `keyring`
 * reader (with a sign-out guard) plus the auth-derived function refs
 * (`openWebSocket`, `onReconnectSignal`) they forward into
 * `openCollaboration`. Config-discovery errors, host auth errors, and startup
 * errors flow back as one `Result` union.
 */

import { resolve } from 'node:path';
import type { Keyring } from '@epicenter/encryption';
import { Err, Ok, type Result } from 'wellcrafted/result';

import {
	loadProjectConfig,
	type ProjectConfigError,
} from '../config/load-project-config.js';
import type {
	CollaborativeMount,
	CollaborativeMountContext,
	LocalMountContext,
	Mount,
} from '../daemon/define-mount.js';
import { validateMountNames } from '../daemon/mount-validation.js';
import type { StartedMount } from '../daemon/types.js';
import { asDeviceId } from '../document/device-id.js';
import { hashYDocClientId } from '../shared/client-id.js';
import type { ProjectDir } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import { WorkspaceAppError } from './errors.js';

type ProjectAuthClient = WorkspaceAuthClient & {
	state: Exclude<WorkspaceAuthClient['state'], { status: 'signed-out' }>;
};

export type OpenProjectOptions<TAuthError = never> = {
	projectDir: ProjectDir | string;
	loadAuth?: () => Promise<Result<WorkspaceAuthClient | null, TAuthError>>;
};

/**
 * Bring a project's daemon online: import its config, then open every mount it
 * declares. Returns the started mounts or the first config/startup error.
 *
 * Opens run in parallel because each mount owns its own resources. If any open
 * fails, every successfully opened runtime is disposed before returning the
 * first failure.
 */
export async function openProject<TAuthError = never>(
	options: OpenProjectOptions<TAuthError>,
): Promise<
	Result<StartedMount[], ProjectConfigError | WorkspaceAppError | TAuthError>
> {
	const projectDir = resolve(options.projectDir) as ProjectDir;

	const { data: mounts, error: configError } =
		await loadProjectConfig(projectDir);
	if (configError !== null) return Err(configError);

	const issue = validateMountNames(mounts.map((mount) => mount.name));
	if (issue !== null) {
		return WorkspaceAppError.MountRejected(issue);
	}

	const collaborativeMounts = mounts.filter(isCollaborativeMount);
	const authResult = await loadAuthIfNeeded({
		loadAuth: options.loadAuth,
		collaborativeMounts,
	});
	if (authResult.error) return Err(authResult.error);
	const auth = authResult.data;

	const settled = await Promise.allSettled(
		mounts.map((mount) => openOneMount({ mount, projectDir, auth })),
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

async function openOneMount({
	mount,
	projectDir,
	auth,
}: {
	mount: Mount;
	projectDir: ProjectDir;
	auth: ProjectAuthClient | null;
}): Promise<Result<StartedMount, WorkspaceAppError>> {
	const baseContext = {
		projectDir,
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

		const authRequired = requireProjectAuth({
			auth,
			mounts: [mount.name],
		});
		if (authRequired.error) return authRequired;
		const collaborativeAuth = authRequired.data;

		const ctx = {
			...baseContext,
			yDocClientId: hashYDocClientId(projectDir),
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
}): Promise<Result<ProjectAuthClient | null, WorkspaceAppError | TAuthError>> {
	if (collaborativeMounts.length === 0) return Ok(null);
	const result = loadAuth ? await loadAuth() : Ok(null);
	if (result.error) return Err(result.error);
	return requireProjectAuth({
		auth: result.data,
		mounts: collaborativeMounts.map((mount) => mount.name),
	});
}

function isCollaborativeMount(mount: Mount): mount is CollaborativeMount {
	return mount.kind === 'collaborative';
}

function requireProjectAuth({
	auth,
	mounts,
}: {
	auth: WorkspaceAuthClient | null;
	mounts: string[];
}): Result<ProjectAuthClient, WorkspaceAppError> {
	if (!hasProjectAuth(auth)) {
		return WorkspaceAppError.ProjectAuthRequired({ mounts });
	}
	return Ok(auth);
}

function hasProjectAuth(
	auth: WorkspaceAuthClient | null,
): auth is ProjectAuthClient {
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
