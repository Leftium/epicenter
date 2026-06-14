/**
 * Compile-time tests for `defineMount` / `defineSessionMount`.
 *
 * Every mount receives one context: `epicenterRoot`, `mount`, and a nullable
 * `session`. The signed-in capabilities (keyring, socket, identity) live under
 * `session`, so the logged-out case is in front of the author at the type level
 * and cannot be reached without a null check. `defineSessionMount` does that
 * null check once and hands the body a non-null `session`.
 *
 * Pattern: each assertion is exported so that `noUnusedLocals` does not flag
 * it. If an assertion fails, the type error appears at the offending line
 * during typecheck.
 */

import { defineMount, defineSessionMount, inactive } from './define-mount.js';

export const localMount = defineMount({
	name: 'mirror',
	open(ctx) {
		ctx.epicenterRoot;
		ctx.mount;
		ctx.session;

		// @ts-expect-error: identity is derived from epicenterRoot, not on ctx
		ctx.yDocClientId;
		// @ts-expect-error: the device id is derived from `mount`, not on ctx
		ctx.deviceId;
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

		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});

export const sessionMount = defineSessionMount({
	name: 'fuji',
	open(ctx) {
		// No null check: the body only runs with a present session.
		ctx.session.keyring();
		ctx.session.openWebSocket;
		ctx.session.ownerId;
		ctx.epicenterRoot;
		ctx.mount;

		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});

export const minimalMount = defineMount({
	name: 'minimal',
	open() {
		return {
			actions: {},
			async [Symbol.asyncDispose]() {},
		};
	},
});
