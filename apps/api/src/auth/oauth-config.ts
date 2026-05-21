/**
 * OAuth scopes every first-party Epicenter app requests and trusted clients get.
 *
 * Keep this list in sync with the resource boundary checks. `workspaces:open`
 * is the capability that lets an access token cross from login into workspace
 * resources; `offline_access` is what lets local-first clients refresh without
 * another hosted sign-in.
 */
export const AUTH_OAUTH_SCOPES = [
	'openid',
	'profile',
	'email',
	'offline_access',
	'workspaces:open',
] as const;
