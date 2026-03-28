import type { BetterAuthOptions } from 'better-auth';
import type { customSession } from 'better-auth/plugins';
import type { EpicenterSessionResponse } from './session-contract';

/**
 * Type-only handle for Epicenter's Better Auth configuration.
 *
 * Better Auth's client-side `customSessionClient()` plugin can use this to
 * infer the extra `/auth/get-session` fields produced by the API's
 * `customSession()` plugin without importing the server runtime.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<EpicenterSessionResponse, BetterAuthOptions>
>;

export type EpicenterAuth = {
	options: BetterAuthOptions & {
		plugins: EpicenterCustomSessionPlugin[];
	};
};
