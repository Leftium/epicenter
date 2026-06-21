import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export type QbEnvironment = 'sandbox' | 'production';

/**
 * A persisted QuickBooks OAuth2 token, stored verbatim in the OS keyring keyed
 * by `realmId`. Expiries are absolute ISO timestamps (not the relative
 * `expires_in` QuickBooks returns) so a process that starts hours later can
 * still decide whether the access token is live without knowing when it was
 * issued.
 */
export type TokenSet = {
	realmId: string;
	environment: QbEnvironment;
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: string;
	refreshTokenExpiresAt: string;
	obtainedAt: string;
};

/** Raw QuickBooks bearer-token grant, as returned by the token endpoint. */
export type TokenGrant = {
	token_type: string;
	access_token: string;
	refresh_token: string;
	expires_in: number;
	x_refresh_token_expires_in?: number;
};

export const TokenGrantError = defineErrors({
	InvalidGrant: ({ reason }: { reason: string }) => ({
		message: `QuickBooks token response was malformed: ${reason}`,
		reason,
	}),
});
export type TokenGrantError = InferErrors<typeof TokenGrantError>;

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Normalize a raw token-endpoint payload into a {@link TokenSet}, converting the
 * relative `expires_in` seconds into an absolute timestamp anchored at `now`.
 *
 * `fallbackRefreshToken` covers refresh-token rotation: QuickBooks may omit
 * `refresh_token` on a refresh when the existing one stays valid, so the caller
 * threads the prior token through. An authorization-code exchange must not pass
 * one (there is no prior token to fall back to).
 */
export function tokenSetFromGrant(
	payload: unknown,
	{
		realmId,
		environment,
		now,
		fallbackRefreshToken,
	}: {
		realmId: string;
		environment: QbEnvironment;
		now: number;
		fallbackRefreshToken?: string;
	},
): Result<TokenSet, TokenGrantError> {
	if (payload === null || typeof payload !== 'object') {
		return TokenGrantError.InvalidGrant({ reason: 'expected a JSON object' });
	}
	const record = payload as Record<string, unknown>;

	const tokenType = asString(record['token_type']);
	if (!tokenType || tokenType.toLowerCase() !== 'bearer') {
		return TokenGrantError.InvalidGrant({
			reason: `expected token_type "bearer", got ${JSON.stringify(record['token_type'])}`,
		});
	}

	const accessToken = asString(record['access_token']);
	if (!accessToken) {
		return TokenGrantError.InvalidGrant({ reason: 'missing access_token' });
	}

	const refreshToken = asString(record['refresh_token']) ?? fallbackRefreshToken;
	if (!refreshToken) {
		return TokenGrantError.InvalidGrant({ reason: 'missing refresh_token' });
	}

	const expiresIn = record['expires_in'];
	if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		return TokenGrantError.InvalidGrant({ reason: 'missing or invalid expires_in' });
	}

	// QuickBooks refresh tokens live ~100 days. When absent, assume the floor so
	// we never treat a usable refresh token as expired (a too-early refresh just
	// gets a fresh window back).
	const refreshExpiresIn =
		typeof record['x_refresh_token_expires_in'] === 'number'
			? (record['x_refresh_token_expires_in'] as number)
			: 100 * 24 * 60 * 60;

	return Ok({
		realmId,
		environment,
		accessToken,
		refreshToken,
		accessTokenExpiresAt: new Date(now + expiresIn * 1000).toISOString(),
		refreshTokenExpiresAt: new Date(now + refreshExpiresIn * 1000).toISOString(),
		obtainedAt: new Date(now).toISOString(),
	});
}

/** Default skew: refresh a little early so an in-flight request never races expiry. */
export const ACCESS_TOKEN_SKEW_MS = 2 * 60 * 1000;

export function accessTokenTtlMs(token: TokenSet, now: number): number {
	return Date.parse(token.accessTokenExpiresAt) - now;
}

export function isAccessTokenExpired(
	token: TokenSet,
	now: number,
	skewMs: number = ACCESS_TOKEN_SKEW_MS,
): boolean {
	return accessTokenTtlMs(token, now) <= skewMs;
}

export function isRefreshTokenExpired(token: TokenSet, now: number): boolean {
	return Date.parse(token.refreshTokenExpiresAt) <= now;
}

/** Human-friendly "in 42m" / "expired 3m ago" for `status`. */
export function formatRelative(targetIso: string, now: number): string {
	const deltaMs = Date.parse(targetIso) - now;
	const abs = Math.abs(deltaMs);
	const mins = Math.round(abs / 60000);
	const unit =
		mins < 60
			? `${mins}m`
			: mins < 60 * 24
				? `${Math.round(mins / 60)}h`
				: `${Math.round(mins / (60 * 24))}d`;
	return deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
}
