// Mirror of @epicenter/constants/{api-routes,oauth-routes}. Vendored here so
// @epicenter/auth can publish without a runtime dependency on the private
// @epicenter/constants package. These are protocol endpoints shared with the
// server; keep both copies in sync until auth owns this surface outright.
const stripTrailing = (s: string) => s.replace(/\/+$/, '');

export const API_ROUTES = {
	session: {
		pattern: '/api/session',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/api/session`,
	},
} as const;

export const OAUTH_ROUTES = {
	cliCallback: {
		pattern: '/auth/cli-callback',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/auth/cli-callback`,
	},
	token: {
		pattern: '/auth/oauth2/token',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/auth/oauth2/token`,
	},
	authorize: {
		pattern: '/auth/oauth2/authorize',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/auth/oauth2/authorize`,
	},
	revoke: {
		pattern: '/auth/oauth2/revoke',
		url: (baseURL: string) => `${stripTrailing(baseURL)}/auth/oauth2/revoke`,
	},
} as const;
