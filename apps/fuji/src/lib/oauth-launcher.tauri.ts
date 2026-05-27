import type { OAuthTokenGrant } from '@epicenter/auth';
import {
	createOAuthClient,
	type OAuthClientConfig,
	OAuthClientError,
	type OAuthLauncher,
} from '@epicenter/auth/oauth-launchers';
import { EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI } from '@epicenter/constants/oauth';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Result } from 'wellcrafted/result';

export function createFujiOAuthLauncher({
	redirectUri = EPICENTER_FUJI_TAURI_OAUTH_REDIRECT_URI,
	...config
}: Omit<OAuthClientConfig, 'redirectUri'> & {
	redirectUri?: string;
}): OAuthLauncher {
	const client = createOAuthClient({ ...config, redirectUri });

	return {
		async startSignIn() {
			const currentUrls = await getCurrent().catch(() => null);
			const currentCallback = currentUrls?.find((url) =>
				isRedirectUrl(url, redirectUri),
			);
			if (currentCallback) return client.handleCallback(currentCallback);

			const urlResult = await client.createAuthorizationUrl();
			if (urlResult.error) return urlResult;

			return await waitForOAuthCallback({
				authorizationUrl: urlResult.data.toString(),
				redirectUri,
				handleCallback: client.handleCallback,
			});
		},
	};
}

function isRedirectUrl(url: string, redirectUri: string): boolean {
	return url === redirectUri || url.startsWith(`${redirectUri}?`);
}

async function waitForOAuthCallback({
	authorizationUrl,
	redirectUri,
	handleCallback,
}: {
	authorizationUrl: string;
	redirectUri: string;
	handleCallback: (
		url: string | URL,
	) => Promise<Result<OAuthTokenGrant | null, OAuthClientError>>;
}) {
	return await new Promise<Result<OAuthTokenGrant | null, OAuthClientError>>(
		(resolve) => {
			let settled = false;
			let unlisten: UnlistenFn | null = null;

			const settle = (
				result: Result<OAuthTokenGrant | null, OAuthClientError>,
			) => {
				if (settled) return;
				settled = true;
				unlisten?.();
				resolve(result);
			};

			onOpenUrl((urls) => {
				const callbackUrl = urls.find((url) => isRedirectUrl(url, redirectUri));
				if (!callbackUrl) return;
				void handleCallback(callbackUrl).then(settle);
			})
				.then((nextUnlisten) => {
					unlisten = nextUnlisten;
					return openUrl(authorizationUrl);
				})
				.catch((cause) => {
					settle(OAuthClientError.LaunchFailed({ cause }));
				});
		},
	);
}
