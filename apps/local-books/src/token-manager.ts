import { Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import { OAuthError, refreshAccessToken } from './oauth.ts';
import type { TokenStore } from './token-store.ts';
import {
	isAccessTokenExpired,
	isRefreshTokenExpired,
	type TokenGrantError,
	type TokenSet,
} from './tokens.ts';

export type TokenError = OAuthError | TokenGrantError;

/**
 * Owns the live access token for one realm: hands out a valid bearer token,
 * refreshing transparently when it is near expiry or when the API rejects it
 * (401). Every refresh persists the rotated token set back to the token store so
 * the next process starts from the newest credentials.
 */
export type TokenManager = {
	current(): TokenSet;
	getValidAccessToken(): Promise<Result<string, TokenError>>;
	forceRefresh(): Promise<Result<string, TokenError>>;
};

export function createTokenManager({
	config,
	store,
	token,
	now,
}: {
	config: AppConfig;
	store: TokenStore;
	token: TokenSet;
	now: () => number;
}): TokenManager {
	let current = token;

	async function refresh(): Promise<Result<string, TokenError>> {
		if (isRefreshTokenExpired(current, now())) {
			return OAuthError.ReauthRequired({ reason: 'refresh token expired' });
		}
		const { data: refreshed, error } = await refreshAccessToken(
			config,
			current,
			now,
		);
		if (error) return { data: null, error };
		current = refreshed;
		await store.set(refreshed);
		return Ok(refreshed.accessToken);
	}

	return {
		current: () => current,
		async getValidAccessToken() {
			if (!isAccessTokenExpired(current, now())) return Ok(current.accessToken);
			return refresh();
		},
		forceRefresh: refresh,
	};
}
