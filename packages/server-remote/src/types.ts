import {
	PROVIDER_ENV_VARS,
	type SupportedProvider,
} from '@epicenter/sync-core';

/** Derived from PROVIDER_ENV_VARS — adding a provider there auto-extends this. */
export type ApiKeyBindings = {
	[K in SupportedProvider as (typeof PROVIDER_ENV_VARS)[K]]?: string;
};

export type SessionResult = {
	user: { id: string; name: string; email: string; [key: string]: unknown };
	session: { id: string; [key: string]: unknown };
};

import type { Auth } from 'better-auth';

/** Auth instance with oauth-provider plugin APIs preserved. */
export type AuthWithOAuth = Auth & {
	api: {
		getOpenIdConfig: (...args: unknown[]) => unknown;
		getOAuthServerConfig: (...args: unknown[]) => unknown;
	};
};

export type Variables = {
	auth: AuthWithOAuth;
	user: SessionResult['user'];
	session: SessionResult['session'];
};

/** Minimal environment shape that the shared route handlers require. */
export type Env = {
	Bindings: ApiKeyBindings;
	Variables: Variables;
};
