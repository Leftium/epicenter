/**
 * Native Git transfers for the boot Account's hosted folders.
 *
 * Rust's Git runner never holds an Epicenter credential. For each fetch or
 * push it asks this owner, over the native control routes, for one relay: a
 * capability path on the host's own loopback listener that forwards exactly
 * the smart-HTTP requests of one service for one paired folder revision to
 * the hosted GitHub connector, through the Account captured at boot. Git is
 * given only `http://127.0.0.1:<port>/_epicenter/git-relay/<64 hex>/repo.git`;
 * the Account adds its own bearer, and the connector holds the GitHub grant.
 *
 * A relay ends when Rust retires it (completion, cancellation before Git is
 * killed, setup failure) or when the Account is disposed, which retires every
 * relay at once. Retiring aborts in-flight upstream requests and makes the
 * path answer 404. Nothing here retries: the Account's own refresh-and-replay
 * after an Epicenter 401 happens before the connector admits a Git request,
 * and every other refusal reaches Git as a plain 502 with no challenge, so
 * Git never asks a credential helper or a person for anything. The refusal's
 * connector code is kept for Rust to read when it retires the relay.
 *
 * Pairing discovery is a read. It never selects or rewrites a folder's
 * binding; the native caller records the selection it explicitly made.
 */
import { randomBytes } from 'node:crypto';
import type { Account } from '@epicenter/auth';
import type { AccountIdentity } from '@epicenter/principal';

/** Control routes for the native host only: launch token, no Origin, no cookie. */
export const NATIVE_GIT_ROUTE = '/_epicenter/native/git';
/** Relay capability paths: `/<token>/repo.git/...`. */
export const GIT_RELAY_ROUTE = '/_epicenter/git-relay';

const CONNECTOR_PATH = '/api/git/github';
const GIT_ERROR_HEADER = 'x-epicenter-git-error';
/** Relays alive at once; a native owner retires each one it starts. */
const MAX_RELAYS = 16;

export type GitService = 'git-upload-pack' | 'git-receive-pack';
const SERVICES: readonly GitService[] = ['git-upload-pack', 'git-receive-pack'];

/** One folder's pairing, as the connector reported it to the boot Account. */
export type HostedPairing = {
	account: AccountIdentity;
	folderId: string;
	revision: string;
	repository: { id: number; installationId: number; fullName: string };
	remote: { url: string; branch: string };
};

/**
 * Why a native control call did not do what it asked. `message` is what a
 * person may be shown; it never names a principal.
 */
export type NativeGitRefusal = {
	status: number;
	error:
		| 'signed-out'
		| 'account-mismatch'
		| 'retired'
		| 'invalid-request'
		| 'pairing-not-found'
		| 'not-ready'
		| 'invalid-pairing'
		| 'session'
		| 'connector'
		| 'unavailable'
		| 'busy';
	code?: string;
	message: string;
};

/** What went wrong upstream during a relay's life, kept for its retirement. */
export type RelayFailure = {
	reason: 'redirect' | 'session' | 'connector' | 'http' | 'unavailable';
	status?: number;
	code?: string;
};

type Relay = {
	id: string;
	token: string;
	target: string;
	service: GitService;
	controller: AbortController;
	failure?: RelayFailure;
};

const FOLDER_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const REVISION = /^[A-Za-z0-9_-]{22}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Request headers Git's smart HTTP needs and the connector accepts. */
const FORWARDED_REQUEST = [
	'accept',
	'content-type',
	'content-encoding',
	'git-protocol',
];
/** Response headers Git reads; cookies, `location`, and challenges stay upstream. */
const FORWARDED_RESPONSE = ['content-type', 'expires', 'pragma'];

const MESSAGES = {
	signedOut: 'Sign in to Epicenter to use this folder with GitHub.',
	accountMismatch:
		'This folder belongs to a different Epicenter account than the one signed in. Quit and reopen Epicenter.',
	retired: 'Epicenter is restarting. Try again once it is open.',
	invalid: 'Epicenter refused a malformed folder transfer request.',
	notFound:
		"This app's data is not connected to a GitHub repository for your account. Connect it in the app's browser version first.",
	notReady: 'Reconnect GitHub for your Epicenter account, then try again.',
	invalidPairing:
		'The GitHub connection for this folder is not one Epicenter can use.',
	session: 'Your Epicenter sign-in needs attention. Sign in again, then retry.',
	unavailable:
		'Epicenter could not reach its server. Check your connection and try again.',
	busy: 'Too many folder transfers are running. Try again in a moment.',
} as const;

function refusal(
	status: number,
	error: NativeGitRefusal['error'],
	message: string,
	code?: string,
): NativeGitRefusal {
	return { status, error, message, ...(code === undefined ? {} : { code }) };
}

/** The refusal for a native control request whose body is not the expected shape. */
export function refuseInvalidNativeGitRequest(): NativeGitRefusal {
	return refusal(400, 'invalid-request', MESSAGES.invalid);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0;
const isFolderId = (value: unknown): value is string =>
	typeof value === 'string' && FOLDER_ID.test(value);
const isRevision = (value: unknown): value is string =>
	typeof value === 'string' && REVISION.test(value);
const isBranch = (value: unknown): value is string =>
	typeof value === 'string' &&
	BRANCH.test(value) &&
	!value.includes('..') &&
	!value.endsWith('/') &&
	!value.endsWith('.lock');
export const isGitService = (value: unknown): value is GitService =>
	SERVICES.includes(value as GitService);

/** `https://github.com/<owner>/<name>.git`, written exactly as the URL parser would. */
function isCanonicalCloneUrl(value: unknown): value is string {
	if (typeof value !== 'string' || !URL.canParse(value)) return false;
	const url = new URL(value);
	return (
		url.href === value &&
		url.protocol === 'https:' &&
		url.hostname === 'github.com' &&
		url.port === '' &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)
	);
}

/** An exact `{ authorityId, principalId }`, nothing more. */
export function parseAccountIdentity(value: unknown): AccountIdentity | null {
	if (!isObject(value)) return null;
	const keys = Object.keys(value);
	if (
		keys.length !== 2 ||
		!isText(value.authorityId) ||
		!isText(value.principalId)
	)
		return null;
	return {
		authorityId: value.authorityId,
		principalId: value.principalId,
	} as AccountIdentity;
}

function sameAccount(account: AccountIdentity, other: AccountIdentity) {
	return (
		account.authorityId === other.authorityId &&
		account.principalId === other.principalId
	);
}

function connectorCode(response: Response): string | undefined {
	const code = response.headers.get(GIT_ERROR_HEADER);
	return code !== null && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
}

/** Readiness, repository, and remote of one pairing entry, or `undefined`. */
function parsePairing(
	value: unknown,
	account: AccountIdentity,
): (HostedPairing & { status: string }) | undefined {
	if (
		!isObject(value) ||
		!isObject(value.repository) ||
		!isObject(value.remote)
	)
		return undefined;
	const { folderId, revision, status } = value;
	const { id, installationId, fullName } = value.repository;
	const { url, branch } = value.remote;
	if (
		!isFolderId(folderId) ||
		!isRevision(revision) ||
		typeof status !== 'string' ||
		!isId(id) ||
		!isId(installationId) ||
		!isText(fullName) ||
		!isText(url) ||
		!isBranch(branch)
	)
		return undefined;
	return {
		account: { authorityId: account.authorityId, principalId: account.principalId },
		folderId,
		revision,
		status,
		repository: { id, installationId, fullName },
		remote: { url, branch },
	};
}

/**
 * The relay owner for one boot Account, or for none when the host booted
 * signed out. `signal` is the Account's disposal: when it aborts, every relay
 * is retired and nothing new starts.
 */
export function createAccountGitRelay({
	account,
	origin,
	signal,
}: {
	account: Account | null;
	/** The host's exact loopback origin, where relay paths are served. */
	origin: string;
	signal: AbortSignal;
}) {
	const byToken = new Map<string, Relay>();
	const byId = new Map<string, Relay>();
	const connector = account
		? `${new URL(account.baseURL).origin}${CONNECTOR_PATH}`
		: undefined;

	function retireAll() {
		for (const relay of byId.values()) relay.controller.abort();
		byId.clear();
		byToken.clear();
	}
	if (signal.aborted) retireAll();
	else signal.addEventListener('abort', retireAll, { once: true });

	/** The boot Account, when it is the one `identity` names and is still alive. */
	function admit(
		identity: AccountIdentity,
	): { account: Account; connector: string } | NativeGitRefusal {
		if (!account || !connector) return refusal(409, 'signed-out', MESSAGES.signedOut);
		if (!sameAccount(account, identity))
			return refusal(409, 'account-mismatch', MESSAGES.accountMismatch);
		if (signal.aborted) return refusal(503, 'retired', MESSAGES.retired);
		return { account, connector };
	}

	return {
		/**
		 * Read `folderId`'s pairing for the boot Account. A read only: what the
		 * caller does with it is its own explicit selection.
		 */
		async pairing(
			identity: AccountIdentity,
			folderId: string,
			{ signal: caller }: { signal?: AbortSignal } = {},
		): Promise<{ pairing: HostedPairing } | NativeGitRefusal> {
			if (!isFolderId(folderId))
				return refusal(400, 'invalid-request', MESSAGES.invalid);
			const admitted = admit(identity);
			if ('error' in admitted) return admitted;
			let response: Response;
			try {
				response = await admitted.account.fetch(`${admitted.connector}/pairings`, {
					method: 'GET',
					headers: { accept: 'application/json' },
					signal: caller ? AbortSignal.any([caller, signal]) : signal,
					credentials: 'omit',
					keepalive: false,
					cache: 'no-store',
				});
			} catch (cause) {
				if (signal.aborted) return refusal(503, 'retired', MESSAGES.retired);
				// A paused Account (reauthentication required) refuses before sending.
				if (isObject(cause) && cause.name === 'AccountUnavailable')
					return refusal(401, 'session', MESSAGES.session);
				return refusal(503, 'unavailable', MESSAGES.unavailable);
			}
			if (response.status === 401) {
				await response.body?.cancel();
				return refusal(401, 'session', MESSAGES.session);
			}
			if (!response.ok) {
				const code = connectorCode(response);
				await response.body?.cancel();
				if (response.status >= 300 && response.status < 400)
					return refusal(502, 'unavailable', MESSAGES.unavailable);
				return code === 'github_authorization_required' ||
					code === 'github_account_mismatch'
					? refusal(409, 'not-ready', MESSAGES.notReady, code)
					: refusal(502, 'connector', MESSAGES.unavailable, code);
			}
			const body: unknown = await response.json().catch(() => undefined);
			if (!isObject(body) || !Array.isArray(body.pairings))
				return refusal(502, 'invalid-pairing', MESSAGES.invalidPairing);
			const entry: unknown = body.pairings.find(
				(candidate: unknown) =>
					isObject(candidate) && candidate.folderId === folderId,
			);
			if (entry === undefined)
				return refusal(404, 'pairing-not-found', MESSAGES.notFound);
			const parsed = parsePairing(entry, admitted.account);
			if (
				parsed === undefined ||
				parsed.folderId !== folderId ||
				!isCanonicalCloneUrl(parsed.remote.url)
			)
				return refusal(502, 'invalid-pairing', MESSAGES.invalidPairing);
			if (parsed.status !== 'ready')
				return refusal(409, 'not-ready', MESSAGES.notReady, parsed.status);
			const { status: _status, ...pairing } = parsed;
			return { pairing };
		},

		/**
		 * Start one relay for `service` of `folderId` at `revision`. The
		 * connector refuses a revision a replaced pairing superseded, so the
		 * relay can only ever reach the repository that revision was paired
		 * with.
		 */
		start({
			account: identity,
			folderId,
			revision,
			service,
		}: {
			account: AccountIdentity;
			folderId: string;
			revision: string;
			service: GitService;
		}): { id: string; url: string } | NativeGitRefusal {
			if (!isFolderId(folderId) || !isRevision(revision) || !isGitService(service))
				return refusal(400, 'invalid-request', MESSAGES.invalid);
			const admitted = admit(identity);
			if ('error' in admitted) return admitted;
			if (byId.size >= MAX_RELAYS) return refusal(429, 'busy', MESSAGES.busy);
			// Lowercase hex: the URL also appears inside Git `-c` config subsections.
			const token = randomBytes(32).toString('hex');
			const relay: Relay = {
				id: randomBytes(16).toString('hex'),
				token,
				target: `${admitted.connector}/git/${folderId}/${revision}`,
				service,
				controller: new AbortController(),
			};
			byToken.set(token, relay);
			byId.set(relay.id, relay);
			return {
				id: relay.id,
				url: `${origin}${GIT_RELAY_ROUTE}/${token}/repo.git`,
			};
		},

		/**
		 * Retire one relay: abort its upstream requests and refuse its path.
		 * `retired` is false when it was already gone, retired by the Account's
		 * disposal or never started here.
		 */
		retire(id: string): { retired: boolean; failure?: RelayFailure } {
			const relay = byId.get(id);
			if (!relay) return { retired: false };
			relay.controller.abort();
			byId.delete(id);
			byToken.delete(relay.token);
			return {
				retired: true,
				...(relay.failure ? { failure: { ...relay.failure } } : {}),
			};
		},

		/** How many relays are alive. */
		get size() {
			return byId.size;
		},

		/**
		 * Answer one request Git sent to a relay path. `rest` is everything
		 * after the token, such as `/repo.git/info/refs`.
		 */
		async handle(request: Request, token: string, rest: string): Promise<Response> {
			const relay = byToken.get(token);
			if (!relay || !account) return new Response('Not Found\n', { status: 404 });
			// Git never sends an Origin; a page does.
			if (request.headers.get('origin') !== null)
				return new Response('Forbidden\n', { status: 403 });
			const url = new URL(request.url);
			const { service } = relay;
			let target: string;
			if (rest === '/repo.git/info/refs') {
				if (request.method !== 'GET')
					return new Response('Method Not Allowed\n', { status: 405 });
				if (url.search !== `?service=${service}`)
					return new Response('Forbidden\n', { status: 403 });
				target = `${relay.target}/info/refs?service=${service}`;
			} else if (rest === `/repo.git/${service}`) {
				if (request.method !== 'POST')
					return new Response('Method Not Allowed\n', { status: 405 });
				if (
					url.search !== '' ||
					request.headers.get('content-type') !==
						`application/x-${service}-request`
				)
					return new Response('Unsupported Media Type\n', { status: 415 });
				target = `${relay.target}/${service}`;
			} else if (SERVICES.some((other) => rest === `/repo.git/${other}`)) {
				return new Response('Forbidden\n', { status: 403 });
			} else {
				return new Response('Not Found\n', { status: 404 });
			}

			const headers = new Headers();
			for (const name of FORWARDED_REQUEST) {
				const value = request.headers.get(name);
				if (value !== null) headers.set(name, value);
			}
			const fail = async (failure: RelayFailure, response?: Response) => {
				relay.failure ??= failure;
				try {
					await response?.body?.cancel();
				} catch {
					// Releasing a refused body cannot change the refusal.
				}
				return new Response('Epicenter could not complete this Git request.\n', {
					status: 502,
					headers: { 'cache-control': 'no-store' },
				});
			};
			let response: Response;
			try {
				response = await account.fetch(target, {
					method: request.method,
					headers,
					body: request.method === 'POST' ? request.body : undefined,
					duplex: 'half',
					redirect: 'manual',
					// Bun otherwise can keep a pooled upload socket open after abort.
					keepalive: false,
					signal: AbortSignal.any([request.signal, relay.controller.signal]),
					credentials: 'omit',
					cache: 'no-store',
				} as RequestInit);
			} catch (cause) {
				return fail({
					reason:
						isObject(cause) && cause.name === 'AccountUnavailable'
							? 'session'
							: 'unavailable',
				});
			}
			if (
				response.type === 'opaqueredirect' ||
				(response.status >= 300 && response.status < 400)
			)
				return fail({ reason: 'redirect', status: response.status }, response);
			if (response.status === 401 || response.status === 407)
				return fail({ reason: 'session', status: response.status }, response);
			if (response.status !== 200) {
				const code = connectorCode(response);
				return fail(
					code === undefined
						? { reason: 'http', status: response.status }
						: { reason: 'connector', status: response.status, code },
					response,
				);
			}
			const outgoing = new Headers({ 'cache-control': 'no-store' });
			for (const name of FORWARDED_RESPONSE) {
				const value = response.headers.get(name);
				if (value !== null) outgoing.set(name, value);
			}
			return new Response(response.body, { status: 200, headers: outgoing });
		},
	};
}

export type AccountGitRelay = ReturnType<typeof createAccountGitRelay>;
