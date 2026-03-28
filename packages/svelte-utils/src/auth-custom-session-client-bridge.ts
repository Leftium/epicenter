import type { BetterAuthOptions } from 'better-auth';
import type { customSession } from 'better-auth/plugins';
import type { EpicenterSessionResponse } from '@epicenter/api/types';

/**
 * Better Auth client-side inference bridge for Epicenter's custom session.
 *
 * Better Auth's `customSessionClient()` wants either the real server auth type
 * or an object shaped like `{ options: { plugins: [...] } }` so it can find the
 * `custom-session` plugin and project its return type into `getSession()`.
 *
 * `@epicenter/svelte` cannot import the API auth runtime because that would
 * drag Cloudflare-specific types into browser/shared packages. Instead we keep
 * this tiny client-owned bridge next to the consuming code.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<EpicenterSessionResponse, BetterAuthOptions>
>;

/**
 * Minimal Better Auth option shape needed for `customSessionClient()`.
 *
 * This is intentionally not named `EpicenterAuth` because it is not the real
 * auth instance type. It is only a compile-time bridge for client inference.
 */
export type EpicenterCustomSessionClientBridge = {
	options: {
		plugins: EpicenterCustomSessionPlugin[];
	};
};
