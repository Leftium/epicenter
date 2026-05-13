import type { BetterAuthOptions } from 'better-auth';

export function createCookieAdvancedConfig(
	baseURL: string,
): NonNullable<BetterAuthOptions['advanced']> {
	const { hostname } = new URL(baseURL);
	if (isLocalhost(hostname)) {
		return {
			useSecureCookies: false,
			defaultCookieAttributes: {
				sameSite: 'lax',
				secure: false,
			},
		};
	}

	return {
		useSecureCookies: true,
		crossSubDomainCookies: {
			enabled: true,
			domain: '.epicenter.so',
		},
		defaultCookieAttributes: {
			sameSite: 'none',
			secure: true,
		},
	};
}

function isLocalhost(hostname: string) {
	return (
		hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
	);
}
