/**
 * Merge a Request/URL/string input with caller-supplied `RequestInit.headers`.
 *
 * Used by both `createBearerAuth` and `createCookieAuth` to produce the
 * Headers object their `fetch` methods then mutate (set Authorization for
 * bearer, delete it for cookie) before delegating to global fetch.
 */
export function headersFromRequest(
	input: Request | string | URL,
	init?: RequestInit,
) {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	copyHeaders(headers, init?.headers);
	return headers;
}

function copyHeaders(target: Headers, source: RequestInit['headers']) {
	if (!source) return;

	if (source instanceof Headers) {
		source.forEach((value, key) => target.set(key, value));
		return;
	}

	const value = source as unknown;

	if (Array.isArray(value)) {
		for (const [key, headerValue] of value) {
			setHeaderValue(target, key, headerValue);
		}
		return;
	}

	if (isHeaderIterable(value)) {
		for (const [key, headerValue] of value) {
			setHeaderValue(target, key, headerValue);
		}
		return;
	}

	for (const [key, headerValue] of Object.entries(
		value as Record<string, string | readonly string[] | undefined>,
	)) {
		setHeaderValue(target, key, headerValue);
	}
}

function setHeaderValue(
	target: Headers,
	key: string,
	value: string | readonly string[] | undefined,
) {
	if (value === undefined) return;
	if (typeof value === 'string') {
		target.set(key, value);
		return;
	}
	for (const item of value) target.append(key, item);
}

function isHeaderIterable(
	value: unknown,
): value is Iterable<readonly [string, string]> {
	return (
		value !== null &&
		typeof value === 'object' &&
		Symbol.iterator in value
	);
}
