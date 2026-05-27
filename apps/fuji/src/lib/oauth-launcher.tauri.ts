import {
	createOAuthClient,
	type OAuthClientConfig,
	OAuthClientError,
	type OAuthLauncher,
	type OAuthLaunchResult,
} from '@epicenter/auth/oauth-launchers';
import { EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI } from '@epicenter/constants/oauth';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * Fuji's Tauri OAuth launcher config.
 *
 * Fuji owns the platform default redirect URI. Tests and local experiments can
 * still override it without making `auth.ts` know about Tauri deep-link
 * details.
 */
type FujiOAuthLauncherConfig = OAuthClientConfig & {
	redirectUri?: string;
};

/**
 * Create Fuji's native-app OAuth launcher.
 *
 * Tauri cannot complete sign-in through a normal page redirect. It opens the
 * hosted OAuth URL in the system browser, then waits for the browser to return
 * to Fuji through the configured custom-scheme deep link.
 */
export function createFujiOAuthLauncher({
	redirectUri = EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
	...config
}: FujiOAuthLauncherConfig): OAuthLauncher {
	const client = createOAuthClient(config);

	return {
		async startSignIn() {
			const currentUrls = await getCurrent().catch(() => null);
			const currentCallback = currentUrls?.find((url) =>
				isRedirectUrl(url, redirectUri),
			);
			if (currentCallback) {
				const callbackResult = await client.exchangeCallback(currentCallback);
				if (callbackResult.error) return callbackResult;
				return Ok({
					status: 'completed',
					grant: callbackResult.data,
				} satisfies OAuthLaunchResult);
			}

			const urlResult = await client.createAuthorizationUrl(redirectUri);
			if (urlResult.error) return urlResult;

			const callbackUrl = await waitForRedirectUrl({
				authorizationUrl: urlResult.data.toString(),
				redirectUri,
			});
			if (callbackUrl.error) return callbackUrl;

			const callbackResult = await client.exchangeCallback(callbackUrl.data);
			if (callbackResult.error) return callbackResult;
			return Ok({
				status: 'completed',
				grant: callbackResult.data,
			} satisfies OAuthLaunchResult);
		},
	};
}

/**
 * Match only callbacks for the exact configured redirect URI.
 *
 * Tauri's deep-link plugin can deliver arbitrary URLs for the registered
 * scheme. The OAuth client still validates state, but the launcher should only
 * claim URLs that belong to this redirect endpoint.
 */
function isRedirectUrl(url: string, redirectUri: string): boolean {
	return url === redirectUri || url.startsWith(`${redirectUri}?`);
}

/**
 * Open the authorization URL after the deep-link listener is installed, then
 * resolve with the first matching callback.
 *
 * The callback is claimed before token exchange starts. That prevents duplicate
 * deep-link events from racing two exchanges for the same authorization code.
 */
async function waitForRedirectUrl({
	authorizationUrl,
	redirectUri,
}: {
	authorizationUrl: string;
	redirectUri: string;
}) {
	return await new Promise<Result<string, OAuthClientError>>((resolve) => {
		let settled = false;
		let callbackClaimed = false;
		let unlisten: UnlistenFn | null = null;

		const settle = (result: Result<string, OAuthClientError>) => {
			if (settled) return;
			settled = true;
			unlisten?.();
			resolve(result);
		};

		onOpenUrl((urls) => {
			if (callbackClaimed) return;
			const callbackUrl = urls.find((url) => isRedirectUrl(url, redirectUri));
			if (!callbackUrl) return;
			callbackClaimed = true;
			unlisten?.();
			settle(Ok(callbackUrl));
		})
			.then((nextUnlisten) => {
				unlisten = nextUnlisten;
				return openUrl(authorizationUrl);
			})
			.catch((cause) => {
				settle(OAuthClientError.LaunchFailed({ cause }));
			});
	});
}
