import type { SchemaClient } from '@better-auth/oauth-provider';
import { APPS, type AppId, localUrl } from '#apps';

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
 * Each entry declares one or more redirect-URI *sources*. The API seed
 * (`ensureTrustedOAuthClients`) expands them against the deployment's own
 * baseURL at cold boot, so a self-host at `https://api.acme.com` or a dev
 * on an unusual port registers its own callbacks without anyone editing
 * this file. At least one source must be set; the seed concatenates them.
 *
 * - `literalUris`     hand-written URIs (e.g. chrome-extension://)
 * - `apiOriginPaths`  paths joined to the deployment's API baseURL
 *                     (e.g. CLI callback, dashboard mounted on /dashboard)
 * - `appOrigins`      paths joined to another Epicenter app's origins, both
 *                     `localUrl(APPS[appId])` and every entry in `urls`
 */
type TrustedPublicOAuthClientDefinition = {
	clientId: NonNullable<SchemaClient['clientId']>;
	name: NonNullable<SchemaClient['name']>;
	type: TrustedPublicOAuthClientType;
	literalUris?: readonly string[];
	apiOriginPaths?: readonly string[];
	appOrigins?: readonly { appId: AppId; path: string }[];
};

/**
 * OAuth public client id for `epicenter auth login`.
 *
 * The CLI uses an out-of-band (OOB) authorization-code + PKCE flow against
 * the same `/auth/oauth2/token` endpoint the browser uses. After sign-in
 * on the hosted portal, Better Auth redirects to the API origin's
 * `/auth/cli-callback`, which renders the one-time code; the user pastes
 * it into the terminal. This identifies the CLI app type, not a user,
 * machine, install, or secret. Every CLI install uses the same value.
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
		apiOriginPaths: ['/dashboard/auth/callback'],
		appOrigins: [{ appId: 'DASHBOARD', path: '/dashboard/auth/callback' }],
	},
	{
		clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
		name: 'Fuji',
		type: 'user-agent-based',
		appOrigins: [{ appId: 'FUJI', path: '/auth/callback' }],
	},
	{
		clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
		name: 'Honeycrisp',
		type: 'user-agent-based',
		appOrigins: [{ appId: 'HONEYCRISP', path: '/auth/callback' }],
	},
	{
		clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
		name: 'Opensidian',
		type: 'user-agent-based',
		appOrigins: [{ appId: 'OPENSIDIAN', path: '/auth/callback' }],
	},
	{
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		name: 'Tab Manager extension',
		type: 'user-agent-based',
		literalUris: ['chrome-extension://mkbnicfhpacdofmoocppnjjmdfmkkgda/'],
	},
	{
		clientId: EPICENTER_ZHONGWEN_OAUTH_CLIENT_ID,
		name: 'Zhongwen',
		type: 'user-agent-based',
		appOrigins: [{ appId: 'ZHONGWEN', path: '/auth/callback' }],
	},
	{
		clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
		name: 'Epicenter CLI',
		type: 'native',
		apiOriginPaths: ['/auth/cli-callback'],
	},
] as const satisfies readonly TrustedPublicOAuthClientDefinition[];

/**
 * Expand a trusted client's redirect-URI sources into concrete URIs for a
 * specific deployment. The API seed calls this once per client at cold
 * boot; tests use the same expander to assert the right URIs land in the
 * DB. Each source contributes zero or more URIs; the result is their
 * concatenation in declaration order.
 */
export function expandTrustedClientRedirectUris(
	client: TrustedPublicOAuthClientDefinition,
	{ apiBaseURL }: { apiBaseURL: string },
): readonly string[] {
	const fromLiteral = client.literalUris ?? [];
	const fromApiOrigin =
		client.apiOriginPaths?.map((path) => `${apiBaseURL}${path}`) ?? [];
	const fromAppOrigins =
		client.appOrigins?.flatMap(({ appId, path }) => {
			const app = APPS[appId];
			return [localUrl(app), ...app.urls].map((origin) => `${origin}${path}`);
		}) ?? [];
	return [...fromLiteral, ...fromApiOrigin, ...fromAppOrigins];
}
