import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import type { AuthFetch } from './auth-contract.js';
import { ApiSessionResponse } from './auth-types.js';

/**
 * The neutral outcome of one bearer `/api/session` read. The variants name the
 * four ways the read can fail; both bearer clients read them directly (a
 * `Rejected` is the 401/403 that drives the OAuth client's `pauseNetworkAuth`
 * and the instance-token client's drop to `signed-out`).
 */
export const ApiSessionReadError = defineErrors({
	/** The `fetch` itself threw (network, DNS, CORS, offline). */
	Unreachable: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach ${API_ROUTES.session.pattern}: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The bearer was rejected with a 401 or 403. */
	Rejected: ({ status }: { status: 401 | 403 }) => ({
		message: `${API_ROUTES.session.pattern} rejected the bearer (${status}).`,
		status,
	}),
	/** The server answered with some other non-ok status. */
	Unexpected: ({ status }: { status: number }) => ({
		message: `${API_ROUTES.session.pattern} failed with ${status}.`,
		status,
	}),
	/** The body could not be read or did not match {@link ApiSessionResponse}. */
	Malformed: ({ cause }: { cause: unknown }) => ({
		message: `${API_ROUTES.session.pattern} returned an unreadable body: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ApiSessionReadError = InferErrors<typeof ApiSessionReadError>;

/**
 * Read `/api/session` once with a bearer token and return the validated session
 * or a neutral failure.
 *
 * This is the single HTTP read of `/api/session` shared by the bearer clients:
 * the OAuth client's grant verification and the instance-token client's boot
 * check both call it. They differ only in how each reacts to an
 * {@link ApiSessionReadError}; the request, the status branching, and the
 * response parsing live here once. The same-origin cookie dashboard is the lone
 * non-bearer reader and keeps its own cookie-credentialed read.
 *
 * `baseURL` should already be normalized (see {@link normalizeInstanceUrl}).
 */
export async function readApiSession({
	baseURL,
	fetch,
	token,
}: {
	baseURL: string;
	fetch: AuthFetch;
	token: string;
}): Promise<Result<ApiSessionResponse, ApiSessionReadError>> {
	let response: Response;
	try {
		response = await fetch(API_ROUTES.session.url(baseURL), {
			headers: { Authorization: `Bearer ${token}` },
			credentials: 'omit',
		});
	} catch (cause) {
		return ApiSessionReadError.Unreachable({ cause });
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			return ApiSessionReadError.Rejected({ status: response.status });
		}
		return ApiSessionReadError.Unexpected({ status: response.status });
	}
	return tryAsync({
		try: async () => ApiSessionResponse.assert(await response.json()),
		catch: (cause) => ApiSessionReadError.Malformed({ cause }),
	});
}
