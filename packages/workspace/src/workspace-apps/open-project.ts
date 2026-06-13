/**
 * Open a project: the single daemon entry point from `epicenter.config.ts` to
 * live mount runtimes.
 *
 * `openProject()` is what `epicenter daemon up` calls. It owns the whole
 * startup path:
 *
 *   1. `loadProjectConfig(epicenterRoot)` imports `epicenter.config.ts` and
 *      validates that its default export is a `Mount[]`.
 *   2. Refuse to start when machine auth is signed out, then validate the
 *      configured mount names.
 *   3. Build a per-mount `MountContext` and run every `open(ctx)` in parallel.
 *      If any open fails, dispose the successfully opened runtimes before
 *      returning the first failure as a structured error.
 *
 * The host owns auth lifecycle. Each `MountContext` carries the lazy `keyring`
 * reader (with a sign-out guard) plus the auth-derived function refs
 * (`openWebSocket`, `onReconnectSignal`) the mount forwards into
 * `openCollaboration`. Config-discovery errors and startup errors flow back as
 * one `Result` union.
 */

import { resolve } from 'node:path';
import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from '@epicenter/identity';
import { Err, Ok, type Result } from 'wellcrafted/result';

import {
	loadProjectConfig,
	type ProjectConfigError,
} from '../config/load-project-config.js';
import type { Mount, MountContext } from '../daemon/define-mount.js';
import { validateMountNames } from '../daemon/mount-validation.js';
import type { StartedMount } from '../daemon/types.js';
import { asDeviceId } from '../document/device-id.js';
import { hashYDocClientId } from '../shared/client-id.js';
import type { EpicenterRoot } from '../shared/types.js';
import type { WorkspaceAuthClient } from './auth-client.js';
import { WorkspaceAppError } from './errors.js';

export type OpenProjectOptions = {
	epicenterRoot: EpicenterRoot | string;
	auth: WorkspaceAuthClient;
};

/**
 * Bring a project's daemon online: import its config, then open every mount it
 * declares. Returns the started mounts or the first config/startup error.
 *
 * Opens run in parallel because each mount owns its own resources. If any open
 * fails, every successfully opened runtime is disposed before returning the
 * first failure.
 */
export async function openProject(
	options: OpenProjectOptions,
): Promise<Result<StartedMount[], ProjectConfigError | WorkspaceAppError>> {
	const { auth } = options;
	const epicenterRoot = resolve(options.epicenterRoot) as EpicenterRoot;

	const { data: mounts, error: configError } =
		await loadProjectConfig(epicenterRoot);
	if (configError !== null) return Err(configError);

	if (auth.state.status === 'signed-out') {
		return WorkspaceAppError.WorkspaceAuthSignedOut();
	}

	const issue = validateMountNames(mounts.map((mount) => mount.name));
	if (issue !== null) {
		return WorkspaceAppError.MountRejected(issue);
	}

	// Sign-out is guarded above, so `auth.state.ownerId` is stable here. Pin it
	// to each mount's context so mounts build URLs without re-reading auth
	// state.
	const ownerId = auth.state.ownerId;

	const settled = await Promise.allSettled(
		mounts.map((mount) =>
			openOneMount({ mount, epicenterRoot, auth, ownerId }),
		),
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
	epicenterRoot,
	auth,
	ownerId,
}: {
	mount: Mount;
	epicenterRoot: EpicenterRoot;
	auth: WorkspaceAuthClient;
	ownerId: OwnerId;
}): Promise<Result<StartedMount, WorkspaceAppError>> {
	const ctx = {
		epicenterRoot,
		mount: mount.name,
		yDocClientId: hashYDocClientId(epicenterRoot),
		deviceId: asDeviceId(`${mount.name}-daemon`),
		ownerId,
		keyring: createMountKeyringReader({ auth, mount: mount.name }),
		// `auth.openWebSocket` / `auth.fetch` / `auth.onStateChange` are
		// closure-based on the auth client and do not read `this`, so passing the
		// method reference directly is safe (no `.bind(auth)` needed).
		openWebSocket: auth.openWebSocket,
		fetch: auth.fetch,
		onReconnectSignal: auth.onStateChange,
	} satisfies MountContext;
	try {
		const runtime = await mount.open(ctx);
		return Ok({ mount: mount.name, runtime });
	} catch (cause) {
		return WorkspaceAppError.MountOpenFailed({
			mount: mount.name,
			cause,
		});
	}
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
