import { EPICENTER_TRUSTED_OAUTH_CLIENTS } from '@epicenter/constants/oauth';

export const AUTH_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
	'workspaces:open',
] as const;

export const TRUSTED_OAUTH_CLIENT_IDS = new Set(
	EPICENTER_TRUSTED_OAUTH_CLIENTS.map((client) => client.clientId),
);
