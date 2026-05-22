import type { SchemaClient } from '@better-auth/oauth-provider';

/**
 * Better Auth calls server-side confidential clients `web`.
 *
 * Epicenter's checked-in trusted clients are public PKCE clients:
 * `tokenEndpointAuthMethod: "none"`, `public: true`, and no client secret.
 * For that policy, Better Auth only accepts `native` and `user-agent-based`.
 */
type TrustedPublicOAuthClientType = Extract<
	NonNullable<SchemaClient['type']>,
	'native' | 'user-agent-based'
>;

/**
 * Per-app facts for a checked-in first-party public OAuth client.
 *
 * This is deliberately smaller than Better Auth's full `SchemaClient`. Each
 * entry only says which app is asking and which redirect URIs are allowed. The
 * API seed layer fills in the shared policy for every trusted app: no client
 * secret, PKCE required, consent skipped, authorization-code flow, and the
 * common Epicenter scopes.
 *
 * The fields stay spelled out instead of using `Pick` or a mapped type because
 * this file is meant to be read as config. The Better Auth indexed types keep
 * the field names tied to upstream without making the shape cryptic.
 */
type TrustedPublicOAuthClientDefinition = {
	clientId: NonNullable<SchemaClient['clientId']>;
	name: NonNullable<SchemaClient['name']>;
	type: TrustedPublicOAuthClientType;
	redirectUris: readonly string[];
};

/**
 * OAuth public client id for `epicenter auth login`.
 *
 * The CLI uses an out-of-band (OOB) authorization-code + PKCE flow against
 * the same `/auth/oauth2/token` endpoint the browser uses. After sign-in
 * on the hosted portal, Better Auth redirects to
 * `https://api.epicenter.so/auth/cli-callback`, which renders the one-time
 * code; the user pastes it into the terminal. This identifies the CLI app
 * type, not a user, machine, install, or secret. Every CLI install uses
 * the same value.
 */
export const EPICENTER_CLI_OAUTH_CLIENT_ID = 'epicenter-cli';

export const EPICENTER_DASHBOARD_OAUTH_CLIENT_ID = 'epicenter-dashboard';
export const EPICENTER_FUJI_OAUTH_CLIENT_ID = 'epicenter-fuji';
export const EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID = 'epicenter-honeycrisp';
export const EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID = 'epicenter-opensidian';
export const EPICENTER_OPENSIDIAN_LOCAL_OAUTH_CLIENT_ID =
	EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID;
export const EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID = 'epicenter-tab-manager';
export const EPICENTER_ZHONGWEN_OAUTH_CLIENT_ID = 'epicenter-zhongwen';

export const EPICENTER_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
] as const;

export const EPICENTER_OAUTH_SCOPE = EPICENTER_OAUTH_SCOPES.join(' ');

export const EPICENTER_TRUSTED_OAUTH_CLIENTS = [
	{
		clientId: EPICENTER_DASHBOARD_OAUTH_CLIENT_ID,
		name: 'Epicenter Dashboard',
		type: 'user-agent-based',
		redirectUris: [
			'http://localhost:5178/dashboard/auth/callback',
			'https://api.epicenter.so/dashboard/auth/callback',
		],
	},
	{
		clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
		name: 'Fuji',
		type: 'user-agent-based',
		redirectUris: [
			'http://localhost:5174/auth/callback',
			'https://fuji.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
		name: 'Honeycrisp',
		type: 'user-agent-based',
		redirectUris: [
			'http://localhost:5175/auth/callback',
			'https://honeycrisp.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
		name: 'Opensidian',
		type: 'user-agent-based',
		redirectUris: [
			'http://localhost:5176/auth/callback',
			'https://opensidian.com/auth/callback',
			'https://opensidian.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		name: 'Tab Manager extension',
		type: 'user-agent-based',
		redirectUris: ['https://mkbnicfhpacdofmoocppnjjmdfmkkgda.chromiumapp.org/'],
	},
	{
		clientId: EPICENTER_ZHONGWEN_OAUTH_CLIENT_ID,
		name: 'Zhongwen',
		type: 'user-agent-based',
		redirectUris: [
			'http://localhost:8888/auth/callback',
			'https://zhongwen.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
		name: 'Epicenter CLI',
		type: 'native',
		redirectUris: ['https://api.epicenter.so/auth/cli-callback'],
	},
] as const satisfies readonly TrustedPublicOAuthClientDefinition[];
