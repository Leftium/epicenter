import type { AuthServerClient } from './auth-server-client.ts';
import type { Credential, CredentialStore } from './credential-store.ts';

export type CliLoginResult = {
	status: 'loggedIn';
	credential: Credential;
	device: {
		userCode: string;
		verificationUriComplete: string;
	};
};

export type CliStatusResult =
	| { status: 'signedOut' }
	| { status: 'valid'; credential: Credential }
	| { status: 'expired'; credential: Credential }
	| { status: 'unverified'; credential: Credential; error: unknown }
	| {
			status: 'missingSecrets';
			metadata: Awaited<ReturnType<CredentialStore['getMetadata']>>;
	  };

export type CliLogoutResult =
	| { status: 'signedOut' }
	| { status: 'loggedOut'; serverOrigin: string };

export type CliAuth = ReturnType<typeof createCliAuth>;

export function createCliAuth(
	{
		authServerClient,
		credentialStore,
		openBrowser,
		sleep = Bun.sleep,
		clock = { now: () => new Date() },
	}: {
		authServerClient: AuthServerClient;
		credentialStore: CredentialStore;
		openBrowser?: (url: string) => Promise<void>;
		sleep?: (ms: number) => Promise<void>;
		clock?: { now(): Date };
	},
	{ clientId = 'epicenter-cli' }: { clientId?: string } = {},
) {
	function isExpired(credential: Credential): boolean {
		return Date.parse(credential.session.session.expiresAt) <= clock.now().getTime();
	}

	async function resolveCredential(
		serverOrigin?: string,
	): Promise<Credential | null> {
		return serverOrigin
			? await credentialStore.get(serverOrigin)
			: await credentialStore.getCurrent();
	}

	return {
		async loginWithDeviceCode({
			onDeviceCode,
		}: {
			onDeviceCode?: (device: {
				userCode: string;
				verificationUriComplete: string;
			}) => void | Promise<void>;
		} = {}): Promise<CliLoginResult> {
			const codeData = await authServerClient.requestDeviceCode({ clientId });
			const device = {
				userCode: codeData.user_code,
				verificationUriComplete: codeData.verification_uri_complete,
			};
			await onDeviceCode?.(device);
			await openBrowser?.(codeData.verification_uri_complete);

			let interval = codeData.interval * 1000;
			const deadline = clock.now().getTime() + codeData.expires_in * 1000;

			while (clock.now().getTime() < deadline) {
				await sleep(interval);
				const tokenData = await authServerClient.pollDeviceToken({
					deviceCode: codeData.device_code,
					clientId,
				});

				if ('access_token' in tokenData) {
					const sessionData = await authServerClient.getSession({
						token: tokenData.access_token,
					});
					const bearerToken = sessionData.setAuthToken ?? tokenData.access_token;
					const credential = await credentialStore.save(
						authServerClient.serverOrigin,
						{
							bearerToken,
							session: sessionData.session,
						},
					);
					return { status: 'loggedIn', credential, device };
				}

				switch (tokenData.error) {
					case 'authorization_pending':
						continue;
					case 'slow_down':
						interval += 5_000;
						continue;
					case 'expired_token':
						throw new Error('Device code expired. Please run login again.');
					case 'access_denied':
						throw new Error('Authorization denied: you rejected the request.');
					default:
						throw new Error(tokenData.error_description ?? tokenData.error);
				}
			}
			throw new Error('Device code expired. Please run login again.');
		},

		async status(serverOrigin?: string): Promise<CliStatusResult> {
			const credential = await resolveCredential(serverOrigin);
			if (credential === null) {
				const metadata = await credentialStore.getMetadata(serverOrigin);
				return metadata === null
					? { status: 'signedOut' }
					: { status: 'missingSecrets', metadata };
			}
			if (isExpired(credential)) return { status: 'expired', credential };

			try {
				const remote = await authServerClient.getSession({
					token: credential.bearerToken,
				});
				const next = await credentialStore.save(credential.serverOrigin, {
					bearerToken: remote.setAuthToken ?? credential.bearerToken,
					session: remote.session,
				});
				return { status: 'valid', credential: next };
			} catch (error) {
				return { status: 'unverified', credential, error };
			}
		},

		async logout(serverOrigin?: string): Promise<CliLogoutResult> {
			const credential = await resolveCredential(serverOrigin);
			if (credential === null) return { status: 'signedOut' };

			try {
				await authServerClient.signOut({ token: credential.bearerToken });
			} catch {}

			await credentialStore.clear(credential.serverOrigin);
			return {
				status: 'loggedOut',
				serverOrigin: credential.serverOrigin,
			};
		},
	};
}
