import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import type { Keyring } from './keyring.ts';
import {
	OAuthError,
	type OAuthDeps,
	refreshAccessToken,
} from './oauth.ts';
import type { TokenGrantError } from './tokens.ts';
import {
	isAccessTokenExpired,
	isRefreshTokenExpired,
	type TokenSet,
} from './tokens.ts';

export type TokenError = OAuthError | TokenGrantError;

/**
 * Owns the live access token for one realm: hands out a valid bearer token,
 * refreshing transparently when it is near expiry or when the API rejects it
 * (401). Every refresh persists the rotated token set back to the keyring so the
 * next process starts from the newest credentials.
 */
export type TokenManager = {
	current(): TokenSet;
	getValidAccessToken(): Promise<Result<string, TokenError>>;
	forceRefresh(): Promise<Result<string, TokenError>>;
};

/** Persist a token set under its realm. The whole set is one keyring secret. */
export async function storeToken(keyring: Keyring, token: TokenSet): Promise<void> {
	await keyring.set(token.realmId, JSON.stringify(token));
}

/** Load and validate a stored token set, or `null` if none / unparseable. */
export async function loadToken(
	keyring: Keyring,
	realmId: string,
): Promise<TokenSet | null> {
	const raw = await keyring.get(realmId);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as TokenSet;
		if (typeof parsed?.accessToken === 'string' && typeof parsed?.refreshToken === 'string') {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

export function createTokenManager({
	config,
	keyring,
	token,
	deps,
}: {
	config: AppConfig;
	keyring: Keyring;
	token: TokenSet;
	deps: OAuthDeps;
}): TokenManager {
	let current = token;

	async function refresh(): Promise<Result<string, TokenError>> {
		if (isRefreshTokenExpired(current, deps.now())) {
			return OAuthError.ReauthRequired({ reason: 'refresh token expired' });
		}
		const { data: refreshed, error } = await refreshAccessToken(config, current, deps);
		if (error) return { data: null, error };
		current = refreshed;
		await storeToken(keyring, refreshed);
		return Ok(refreshed.accessToken);
	}

	return {
		current: () => current,
		async getValidAccessToken() {
			if (!isAccessTokenExpired(current, deps.now())) return Ok(current.accessToken);
			return refresh();
		},
		forceRefresh: refresh,
	};
}
