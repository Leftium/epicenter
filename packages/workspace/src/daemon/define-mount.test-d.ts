/**
 * Compile-time tests for `defineMount`.
 *
 * Every mount receives one context: `epicenterRoot`, `mount`, and a nullable
 * `session`. The signed-in capabilities (keyring, socket, identity) live under
 * `session`, so the logged-out case is in front of the author at the type level
 * and cannot be reached without a null check.
 *
 * Pattern: each assertion is exported so that `noUnusedLocals` does not flag
 * it. If an assertion fails, the type error appears at the offending line
 * during typecheck.
 */

import { defineMount, inactive } from './define-mount.js';

export const localMount = defineMount({
	name: 'mirror',
	open(ctx) {
		ctx.epicenterRoot;
		ctx.mount;
		ctx.session;

		// @ts-expect-error: signed-in capabilities live under `session`, not on ctx
		ctx.keyring;
		// @ts-expect-error: signed-in capabilities live under `session`, not on ctx
		ctx.openWebSocket;

		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});

export const sessionAwareMount = defineMount({
	name: 'fuji',
	open(ctx) {
		// @ts-expect-error: session may be null, so it must be narrowed first
		ctx.session.keyring();

		if (ctx.session === null) {
			return inactive('sign in to enable fuji');
		}

		// Narrowed: the full capability kit is available.
		ctx.session.keyring();
		ctx.session.openWebSocket;
		ctx.session.onReconnectSignal;
		ctx.session.fetch;
		ctx.session.ownerId;
		ctx.session.deviceId;
		ctx.session.yDocClientId;

		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});

export const mountWithoutKind = defineMount({
	name: 'no-kind-needed',
	open() {
		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});
