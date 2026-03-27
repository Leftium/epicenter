import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	AuthSession,
	createAuthSession,
	createBetterAuthClientSession,
	createSessionResolver,
	signInWithPassword,
	signOutRemote,
	signUpWithPassword,
} from '@epicenter/svelte/auth';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { ws } from '$lib/workspace';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: AuthSession,
	defaultValue: { status: 'anonymous' },
});

const resolveSession = createSessionResolver({
	baseURL: APP_URLS.API,
});

export const authState = createAuthSession({
	storage: session,
	resolveSession,
	signOutRemote: (current) => signOutRemote({ baseURL: APP_URLS.API, current }),
	onSessionCommitted: async ({ previous, current, reason, userKeyBase64 }) => {
		if (current.status === 'authenticated') {
			if (userKeyBase64) {
				await ws.encryption.unlock(base64ToBytes(userKeyBase64));
				return;
			}

			if (
				reason === 'bootstrap' ||
				reason === 'external-change' ||
				previous.status !== 'authenticated'
			) {
				await ws.encryption.tryUnlock();
			}

			return;
		}

		if (previous.status === 'authenticated') {
			await ws.clearLocalData();
		}
	},
});

export function signIn(input: { email: string; password: string }) {
	return authState.runAuthCommand(
		'sign-in',
		() => signInWithPassword({ baseURL: APP_URLS.API, input }),
		{ requireAuthenticatedSession: true },
	);
}

export function signUp(input: {
	email: string;
	password: string;
	name: string;
}) {
	return authState.runAuthCommand(
		'sign-up',
		() => signUpWithPassword({ baseURL: APP_URLS.API, input }),
		{ requireAuthenticatedSession: true },
	);
}

export function signInWithGoogle() {
	return authState.runAuthCommand(
		'google-sign-in',
		async () => {
			const { client } = createBetterAuthClientSession({
				baseURL: APP_URLS.API,
				authToken: null,
			});
			await client.signIn.social({
				provider: 'google',
				callbackURL: window.location.origin,
			});
			return { status: 'redirect-started' };
		},
		{
			allowRedirectStart: true,
			requireAuthenticatedSession: true,
		},
	);
}
