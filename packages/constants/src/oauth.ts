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

export const EPICENTER_TRUSTED_OAUTH_CLIENTS = [
	{
		clientId: EPICENTER_DASHBOARD_OAUTH_CLIENT_ID,
		name: 'Epicenter Dashboard',
		runtime: 'browser',
		redirectUris: [
			'http://localhost:5178/dashboard/auth/callback',
			'https://api.epicenter.so/dashboard/auth/callback',
		],
	},
	{
		clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
		name: 'Fuji',
		runtime: 'browser',
		redirectUris: [
			'http://localhost:5174/auth/callback',
			'https://fuji.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_HONEYCRISP_OAUTH_CLIENT_ID,
		name: 'Honeycrisp',
		runtime: 'browser',
		redirectUris: [
			'http://localhost:5175/auth/callback',
			'https://honeycrisp.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_OPENSIDIAN_OAUTH_CLIENT_ID,
		name: 'Opensidian',
		runtime: 'browser',
		redirectUris: [
			'http://localhost:5176/auth/callback',
			'https://opensidian.com/auth/callback',
			'https://opensidian.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		name: 'Tab Manager extension',
		runtime: 'extension',
		redirectUris: ['https://mkbnicfhpacdofmoocppnjjmdfmkkgda.chromiumapp.org/'],
	},
	{
		clientId: EPICENTER_ZHONGWEN_OAUTH_CLIENT_ID,
		name: 'Zhongwen',
		runtime: 'browser',
		redirectUris: [
			'http://localhost:8888/auth/callback',
			'https://zhongwen.epicenter.so/auth/callback',
		],
	},
	{
		clientId: EPICENTER_CLI_OAUTH_CLIENT_ID,
		name: 'Epicenter CLI',
		runtime: 'native',
		redirectUris: ['https://api.epicenter.so/auth/cli-callback'],
	},
] as const;
