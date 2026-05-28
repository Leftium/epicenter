/**
 * Typed fetch client for the `/api/billing/*` surface.
 *
 * Responses come back as Epicenter DTOs from `$api/billing/contracts`
 * (sibling Worker code); the dashboard never imports `autumn-js` or sees
 * its wire shapes. Each method returns `Result<T, BillingApiError>` so
 * consumers destructure `{ data, error }` instead of try/catch.
 *
 * Uses `auth.fetch` so the first-party auth cookie rides along on
 * every request. Same-origin deployment; no CORS config needed.
 */

import type {
	BillingEventsPage,
	BillingOverview,
	BillingPlansView,
	CheckoutResult,
	EventsQuery,
	ModelCostGuide,
	PlanChangePreview,
	PortalSession,
	UsageQuery,
	UsageSeries,
} from '$api/billing/contracts';
import type { BillingError } from '$api/billing/errors';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { auth } from '$platform/auth';

/** Tagged error for the billing API boundary. Covers network failures
 *  (fetch throws) and non-OK HTTP responses (the status guard throws). */
export const BillingApiError = defineErrors({
	RequestFailed: ({
		endpoint,
		cause,
	}: {
		endpoint: string;
		cause: unknown;
	}) => ({
		message: `Request to ${endpoint} failed: ${extractErrorMessage(cause)}`,
		endpoint,
		cause,
	}),
});
export type BillingApiError = import('wellcrafted/error').InferErrors<
	typeof BillingApiError
>;

/** Either boundary error: a local fetch/parse failure or the server's own
 *  structured billing error. */
type BillingResult<T> = Result<T, BillingApiError | BillingError>;

/**
 * Interpret a billing response. On a non-OK status the billing routes' onError
 * sends the wellcrafted envelope `{ data: null, error: BillingError }` carrying
 * the upstream status code and Autumn `code`, so we surface that structured
 * error instead of collapsing it to a status line: the dashboard can branch on
 * `error.statusCode === 402` (insufficient credits) or `error.code`. Non-JSON
 * or envelope-less bodies fall back to a generic request failure.
 */
async function readResponse<TResponse>(
	endpoint: string,
	res: Response,
): Promise<BillingResult<TResponse>> {
	const { data: body, error: parseError } = await tryAsync({
		try: () => res.json() as Promise<unknown>,
		catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
	});
	if (parseError) return Err(parseError);

	if (res.ok) return Ok(body as TResponse);

	if (isBillingErrorEnvelope(body)) return Err(body.error);
	return BillingApiError.RequestFailed({
		endpoint,
		cause: new Error(`${res.status} ${res.statusText}`),
	});
}

/** Untrusted-boundary check that a non-OK body is the billing error envelope. */
function isBillingErrorEnvelope(
	body: unknown,
): body is { error: BillingError } {
	return (
		typeof body === 'object' &&
		body !== null &&
		'error' in body &&
		typeof (body as { error: unknown }).error === 'object' &&
		(body as { error: unknown }).error !== null &&
		'name' in (body as { error: object }).error
	);
}

async function get<TResponse>(endpoint: string): Promise<BillingResult<TResponse>> {
	const { data: res, error } = await tryAsync({
		try: () => auth.fetch(endpoint),
		catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
	});
	if (error) return Err(error);
	return readResponse<TResponse>(endpoint, res);
}

async function post<TBody, TResponse>(
	endpoint: string,
	body: TBody,
): Promise<BillingResult<TResponse>> {
	const { data: res, error } = await tryAsync({
		try: () =>
			auth.fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		catch: (cause) => BillingApiError.RequestFailed({ endpoint, cause }),
	});
	if (error) return Err(error);
	return readResponse<TResponse>(endpoint, res);
}

export const billingApi = {
	overview: () => get<BillingOverview>('/api/billing/overview'),

	usage: (params: UsageQuery) =>
		post<UsageQuery, UsageSeries>('/api/billing/usage', params),

	events: (params: EventsQuery = {}) =>
		post<EventsQuery, BillingEventsPage>('/api/billing/events', params),

	plans: () => get<BillingPlansView>('/api/billing/plans'),

	models: () => get<ModelCostGuide>('/api/billing/models'),

	previewPlanChange: (params: { planId: string }) =>
		post<{ planId: string }, PlanChangePreview>('/api/billing/preview', params),

	checkoutPlan: (params: { planId: string; successUrl?: string }) =>
		post<typeof params, CheckoutResult>('/api/billing/checkout/plan', params),

	checkoutTopUp: (params: { successUrl?: string } = {}) =>
		post<typeof params, CheckoutResult>('/api/billing/checkout/top-up', params),

	portal: () => get<PortalSession>('/api/billing/portal'),
};
