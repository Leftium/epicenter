import type { BetterAuthOptions } from 'better-auth';
import type { customSession } from 'better-auth/plugins';
import type { EpicenterSessionResponse } from '@epicenter/api/types';

type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<EpicenterSessionResponse, BetterAuthOptions>
>;

/**
 * Type adapter for Better Auth's `customSessionClient()` generic.
 *
 * Pass this as the type parameter to `customSessionClient<EpicenterAuthPluginShape>()`
 * so `getSession()` infers Epicenter's custom session fields.
 */
export type EpicenterAuthPluginShape = {
	options: {
		plugins: EpicenterCustomSessionPlugin[];
	};
};
