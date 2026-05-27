/**
 * Tauri-only Fuji capabilities.
 *
 * Import `$lib/tauri` from shared code and narrow on `tauri`. Web builds
 * resolve `tauri.browser.ts`, so Tauri plugins never enter the browser bundle.
 */

import type { OAuthTokenGrant } from '@epicenter/auth';
import {
	createOAuthClient,
	type OAuthClientConfig,
	OAuthClientError,
	type OAuthLauncher,
} from '@epicenter/auth/oauth-launchers';
import { invoke } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { appDataDir, join } from '@tauri-apps/api/path';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Result } from 'wellcrafted/result';

export type MarkdownFile = {
	filename: string;
	content: string;
};

function isRedirectUrl(url: string, redirectUri: string): boolean {
	return url === redirectUri || url.startsWith(`${redirectUri}?`);
}

function createTauriOAuthLauncher(config: OAuthClientConfig): OAuthLauncher {
	const client = createOAuthClient(config);

	return {
		async startSignIn() {
			const currentUrls = await getCurrent().catch(() => null);
			const currentCallback = currentUrls?.find((url) =>
				isRedirectUrl(url, config.redirectUri),
			);
			if (currentCallback) return client.handleCallback(currentCallback);

			const urlResult = await client.createAuthorizationUrl();
			if (urlResult.error) return urlResult;

			return await waitForOAuthCallback({
				authorizationUrl: urlResult.data.toString(),
				redirectUri: config.redirectUri,
				handleCallback: client.handleCallback,
			});
		},
	};
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

const markdown = {
	async directory() {
		return await join(await appDataDir(), 'markdown');
	},

	async writeFiles(files: MarkdownFile[]) {
		const directory = await this.directory();
		await invoke('write_markdown_files', { directory, files });
	},

	async readFiles() {
		const directory = await this.directory();
		return await invoke<MarkdownFile[]>('read_markdown_files', { directory });
	},
};

const tauriImpl = {
	oauth: {
		createLauncher: createTauriOAuthLauncher,
	},
	markdown,
};

export type Tauri = typeof tauriImpl;

export const tauri: Tauri | null = tauriImpl;

export function requireTauri(): Tauri {
	if (!tauri) {
		throw new Error('requireTauri() called outside Tauri runtime');
	}
	return tauri;
}
