import type { OAuthClientConfig } from '@epicenter/auth/oauth-launchers';
import { EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI } from '@epicenter/constants/oauth';
import { requireTauri } from './tauri';

export function createFujiOAuthLauncher({
	redirectUri = EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
	...config
}: Omit<OAuthClientConfig, 'redirectUri'> & {
	redirectUri?: string;
}) {
	return requireTauri().oauth.createLauncher({
		...config,
		redirectUri,
	});
}
