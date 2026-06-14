const PRODUCTION_API_URL = 'https://api.epicenter.so';

export const EPICENTER_API_URL =
	(typeof process !== 'undefined' && process.env?.EPICENTER_API_URL) ||
	PRODUCTION_API_URL;

export const EPICENTER_CLI_OAUTH_CLIENT_ID = 'epicenter-cli';

export const EPICENTER_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
] as const;

export const EPICENTER_OAUTH_SCOPE = EPICENTER_OAUTH_SCOPES.join(' ');
