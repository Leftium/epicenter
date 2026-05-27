import type {
	OAuthAuthorizationRequest,
	OAuthClientConfig,
} from '@epicenter/auth/oauth-launchers';
import { createBrowserOAuthLauncher } from '@epicenter/auth/oauth-launchers';

export function createFujiOAuthLauncher({
	redirectUri = `${window.location.origin}/auth/callback`,
	...config
}: OAuthClientConfig & Partial<OAuthAuthorizationRequest>) {
	return createBrowserOAuthLauncher({
		...config,
		redirectUri,
	});
}
