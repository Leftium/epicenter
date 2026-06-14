/**
 * Compile-time tests for `defineMount`.
 *
 * The mount `kind` is the daemon startup contract. Local mounts must not see
 * auth-derived collaboration capabilities, and collaborative mounts must
 * return a runtime with hosted collaboration.
 *
 * Pattern: each assertion is exported so that `noUnusedLocals` does not flag
 * it. If an assertion fails, the type error appears at the offending line
 * during typecheck.
 */

import {
	defineMount,
	type CollaborativeDaemonRuntime,
	type LocalDaemonRuntime,
} from './define-mount.js';
import type { Collaboration } from '../document/open-collaboration.js';
import type { ActionRegistry } from '../shared/actions.js';

declare const collaborativeRuntime: CollaborativeDaemonRuntime;
declare const collaboration: Collaboration<ActionRegistry>;

export const localMount = defineMount({
	name: 'mirror',
	kind: 'local',
	open(ctx) {
		ctx.projectDir;
		ctx.mount;

		// @ts-expect-error: local mounts do not receive workspace keys
		ctx.keyring;
		// @ts-expect-error: local mounts do not receive owner identity
		ctx.ownerId;
		// @ts-expect-error: local mounts do not receive WebSocket access
		ctx.openWebSocket;
		// @ts-expect-error: local mounts do not receive authed fetch
		ctx.fetch;
		// @ts-expect-error: local mounts do not receive reconnect signals
		ctx.onReconnectSignal;
		// @ts-expect-error: local mounts do not receive Y.Doc client ids
		ctx.yDocClientId;
		// @ts-expect-error: local mounts do not receive device ids
		ctx.deviceId;

		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});

export const collaborativeMount = defineMount({
	name: 'fuji',
	kind: 'collaborative',
	open(ctx) {
		ctx.projectDir;
		ctx.mount;
		ctx.keyring;
		ctx.ownerId;
		ctx.openWebSocket;
		ctx.fetch;
		ctx.onReconnectSignal;
		ctx.yDocClientId;
		ctx.deviceId;

		return collaborativeRuntime;
	},
});

// @ts-expect-error: mount definitions must declare a static kind
export const missingKind = defineMount({
	name: 'missing',
	open() {
		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});

export const localRuntimeWithCollaboration = {
	actions: {},
	collaboration,
	async [Symbol.asyncDispose]() {},
};

// @ts-expect-error: local runtimes cannot expose collaboration
export const localRuntimeRejectsCollaboration: LocalDaemonRuntime =
	localRuntimeWithCollaboration;

export const actionsOnlyRuntime = {
	actions: {},
	async [Symbol.asyncDispose]() {},
};

// @ts-expect-error: collaborative runtimes must expose collaboration
export const collaborativeRuntimeRequiresCollaboration: CollaborativeDaemonRuntime =
	actionsOnlyRuntime;
