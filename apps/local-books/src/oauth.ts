import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from './config.ts';
import {
	type TokenGrantError,
	type TokenSet,
	tokenSetFromGrant,
} from './tokens.ts';

/**
 * QuickBooks OAuth2, hand-rolled on `fetch` and `Bun.serve`. The spec blesses
 * this over the official `intuit-oauth` CommonJS package: a dependency-free
 * authorization-code flow survives `bun build --compile` cleanly and keeps the
 * runtime footprint minimal. The exchange and refresh calls hit the same token
 * endpoint with HTTP Basic auth (`clientId:clientSecret`).
 */

export const OAuthError = defineErrors({
	MissingCredentials: () => ({
		message:
			'Missing client credentials. Set LOCAL_BOOKS_QB_CLIENT_ID and LOCAL_BOOKS_QB_CLIENT_SECRET.',
	}),
	Network: ({ cause }: { cause: unknown }) => ({
		message: `Network error talking to the QuickBooks token endpoint: ${String(cause)}`,
		cause,
	}),
	TokenExchangeFailed: ({ status, body }: { status: number; body: string }) => ({
		message: `QuickBooks token endpoint returned ${status}: ${body.slice(0, 500)}`,
		status,
		body,
	}),
	StateMismatch: () => ({
		message: 'OAuth callback state did not match; aborting to avoid a forged callback.',
	}),
	CallbackDenied: ({ error, description }: { error: string; description: string }) => ({
		message: `QuickBooks denied authorization: ${error}${description ? ` (${description})` : ''}`,
		error,
		description,
	}),
	Timeout: ({ ms }: { ms: number }) => ({
		message: `Timed out after ${ms}ms waiting for the OAuth callback.`,
		ms,
	}),
	ReauthRequired: ({ reason }: { reason: string }) => ({
		message: `Re-authentication required: ${reason}. Run "local-books auth".`,
		reason,
	}),
});
export type OAuthError = InferErrors<typeof OAuthError>;

export type OAuthDeps = {
	now: () => number;
	fetchImpl?: typeof fetch;
	openBrowser?: (url: string) => void;
	log?: (message: string) => void;
	/** Callback wait budget; defaults to 5 minutes. */
	timeoutMs?: number;
};

function basicAuthHeader(clientId: string, clientSecret: string): string {
	return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

/** POST the token endpoint and normalize the grant into a {@link TokenSet}. */
async function requestToken(
	config: AppConfig,
	body: URLSearchParams,
	{
		realmId,
		fallbackRefreshToken,
	}: { realmId: string; fallbackRefreshToken?: string },
	deps: OAuthDeps,
): Promise<Result<TokenSet, OAuthError | TokenGrantError>> {
	if (!config.clientId || !config.clientSecret) {
		return OAuthError.MissingCredentials();
	}
	const fetchImpl = deps.fetchImpl ?? fetch;

	let response: Response;
	try {
		response = await fetchImpl(config.tokenUrl, {
			method: 'POST',
			headers: {
				Authorization: basicAuthHeader(config.clientId, config.clientSecret),
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body,
		});
	} catch (cause) {
		return OAuthError.Network({ cause });
	}

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		return OAuthError.TokenExchangeFailed({ status: response.status, body: text });
	}

	const json = await response.json().catch(() => null);
	return tokenSetFromGrant(json, {
		realmId,
		environment: config.environment,
		now: deps.now(),
		fallbackRefreshToken,
	});
}

export function exchangeAuthorizationCode(
	config: AppConfig,
	{ code, realmId }: { code: string; realmId: string },
	deps: OAuthDeps,
): Promise<Result<TokenSet, OAuthError | TokenGrantError>> {
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: config.redirectUri,
	});
	return requestToken(config, body, { realmId }, deps);
}

export function refreshAccessToken(
	config: AppConfig,
	token: TokenSet,
	deps: OAuthDeps,
): Promise<Result<TokenSet, OAuthError | TokenGrantError>> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: token.refreshToken,
	});
	// Rotation: QuickBooks may omit refresh_token when the old one stays valid.
	return requestToken(
		config,
		body,
		{ realmId: token.realmId, fallbackRefreshToken: token.refreshToken },
		deps,
	);
}

export function buildAuthorizeUrl(config: AppConfig, state: string): string {
	const url = new URL(config.authorizeUrl);
	url.searchParams.set('client_id', config.clientId ?? '');
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', config.scopes.join(' '));
	url.searchParams.set('redirect_uri', config.redirectUri);
	url.searchParams.set('state', state);
	return url.toString();
}

function defaultOpenBrowser(url: string): void {
	const cmd =
		process.platform === 'darwin'
			? ['open', url]
			: process.platform === 'win32'
				? ['cmd', '/c', 'start', '', url]
				: ['xdg-open', url];
	try {
		Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
	} catch {
		// Non-fatal: the URL is printed for manual paste.
	}
}

type CallbackResult = Result<{ code: string; realmId: string }, OAuthError>;

/**
 * Run the interactive authorization-code flow: spin up a localhost callback
 * server matching `redirectUri`, send the user to QuickBooks, await the
 * redirect, then exchange the code. Returns the persisted token set on success.
 */
export async function runAuthorizationFlow(
	config: AppConfig,
	deps: OAuthDeps,
): Promise<Result<TokenSet, OAuthError | TokenGrantError>> {
	if (!config.clientId || !config.clientSecret) {
		return OAuthError.MissingCredentials();
	}

	const state = crypto.randomUUID();
	const redirect = new URL(config.redirectUri);
	const port = Number(redirect.port || '80');
	const timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000;
	const log = deps.log ?? (() => {});

	let resolveCallback!: (result: CallbackResult) => void;
	const callbackPromise = new Promise<CallbackResult>((resolve) => {
		resolveCallback = resolve;
	});

	const server = Bun.serve({
		port,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname !== redirect.pathname) {
				return new Response('Not found', { status: 404 });
			}
			const error = url.searchParams.get('error');
			if (error) {
				resolveCallback(
					OAuthError.CallbackDenied({
						error,
						description: url.searchParams.get('error_description') ?? '',
					}),
				);
				return new Response('Authorization denied. You can close this window.', {
					headers: { 'content-type': 'text/html' },
				});
			}
			if (url.searchParams.get('state') !== state) {
				resolveCallback(OAuthError.StateMismatch());
				return new Response('State mismatch. You can close this window.', {
					headers: { 'content-type': 'text/html' },
				});
			}
			const code = url.searchParams.get('code');
			const realmId = url.searchParams.get('realmId');
			if (!code || !realmId) {
				resolveCallback(
					OAuthError.CallbackDenied({
						error: 'invalid_callback',
						description: 'Missing code or realmId in callback.',
					}),
				);
				return new Response('Missing parameters. You can close this window.', {
					headers: { 'content-type': 'text/html' },
				});
			}
			resolveCallback(Ok({ code, realmId }));
			return new Response(
				'<html><body><h2>local-books connected to QuickBooks.</h2><p>You can close this window and return to the terminal.</p></body></html>',
				{ headers: { 'content-type': 'text/html' } },
			);
		},
	});

	const authorizeUrl = buildAuthorizeUrl(config, state);
	log(`Opening your browser to authorize QuickBooks access...`);
	log(`If it does not open, visit:\n  ${authorizeUrl}`);
	(deps.openBrowser ?? defaultOpenBrowser)(authorizeUrl);

	const timeout = new Promise<CallbackResult>((resolve) => {
		setTimeout(() => resolve(OAuthError.Timeout({ ms: timeoutMs })), timeoutMs);
	});

	const callback = await Promise.race([callbackPromise, timeout]);
	server.stop(true);

	if (callback.error) return Err(callback.error);
	return exchangeAuthorizationCode(config, callback.data, deps);
}
