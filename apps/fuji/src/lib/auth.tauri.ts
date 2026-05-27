import { PersistedAuth } from '@epicenter/auth';
import {
	createOAuthClient,
	OAuthClientError,
	type OAuthLauncher,
	type OAuthLaunchResult,
} from '@epicenter/auth/oauth-launchers';
import { createOAuthAppAuth } from '@epicenter/auth-svelte';
import {
	EPICENTER_FUJI_OAUTH_CLIENT_ID,
	EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
} from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Ok, type Result } from 'wellcrafted/result';

export const auth = createOAuthAppAuth({
	baseURL: APP_URLS.API,
	clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
	persistedAuthStorage: createPersistedState({
		key: 'fuji.auth.persisted',
		schema: PersistedAuth.or('null'),
		defaultValue: null,
	}),
	launcher: createFujiOAuthLauncher(),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());
}

function createFujiOAuthLauncher(): OAuthLauncher {
	const redirectUri = EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI;
	const client = createOAuthClient({
		issuer: `${APP_URLS.API}/auth`,
		clientId: EPICENTER_FUJI_OAUTH_CLIENT_ID,
		resource: APP_URLS.API,
		storage: window.sessionStorage,
	});

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
	} satisfies OAuthLauncher;
}

// Tauri can deliver arbitrary URLs for the registered scheme. Claim only the
// exact OAuth redirect endpoint; the OAuth client still validates state.
function isRedirectUrl(url: string, redirectUri: string): boolean {
	return url === redirectUri || url.startsWith(`${redirectUri}?`);
}

// Install the deep-link listener before opening the browser, then resolve the
// first matching callback URL. Token exchange happens after URL capture.
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
