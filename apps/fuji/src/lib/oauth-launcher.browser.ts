import type { OAuthClientConfig } from '@epicenter/auth/oauth-launchers';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';

export function createFujiOAuthLauncher({
	redirectUri = `${window.location.origin}/auth/callback`,
	...config
}: Omit<OAuthClientConfig, 'redirectUri'> & {
	redirectUri?: string;
}) {
	return createBrowserOAuthLauncher({
		...config,
		redirectUri,
	});
}
