/**
 * Single Credential Tests
 *
 * Verifies API-side credential classification before Better Auth receives
 * request headers.
 *
 * Key behaviors:
 * - Cookie and bearer credentials are accepted only when sent alone
 * - WebSocket bearer subprotocols are lifted into Authorization
 * - Mixed cookie and bearer credentials are rejected before session lookup
 */

import { expect, test } from 'bun:test';
import { singleCredential } from './single-credential.js';

test('only-cookie returns cookie headers', () => {
	const result = singleCredential(
		new Headers({
			cookie: 'theme=dark; better-auth.session_token=session-1',
		}),
	);

	expect(result.status).toBe('ok');
	if (result.status !== 'ok') return;
	expect(result.kind).toBe('cookie');
	expect(result.headers.get('cookie')).toContain(
		'better-auth.session_token=session-1',
	);
	expect(result.headers.has('authorization')).toBe(false);
});

test('only-bearer returns bearer headers', () => {
	const result = singleCredential(
		new Headers({
			authorization: 'Bearer token-1',
		}),
	);

	expect(result.status).toBe('ok');
	if (result.status !== 'ok') return;
	expect(result.kind).toBe('bearer');
	expect(result.headers.get('authorization')).toBe('Bearer token-1');
});

test('only-WS-bearer lifts bearer into Authorization', () => {
	const result = singleCredential(
		new Headers({
			'sec-websocket-protocol': 'epicenter, bearer.token-1',
		}),
	);

	expect(result.status).toBe('ok');
	if (result.status !== 'ok') return;
	expect(result.kind).toBe('bearer');
	expect(result.headers.get('authorization')).toBe('Bearer token-1');
});

test('mixed cookie and bearer returns mixed', () => {
	const result = singleCredential(
		new Headers({
			authorization: 'Bearer token-1',
			cookie: 'better-auth.session_token=session-1',
		}),
	);

	expect(result).toEqual({ status: 'mixed' });
});

test('mixed cookie and WS bearer returns mixed', () => {
	const result = singleCredential(
		new Headers({
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter, bearer.token-1',
		}),
	);

	expect(result).toEqual({ status: 'mixed' });
});

test('neither returns none with headers', () => {
	const result = singleCredential(new Headers({ accept: 'application/json' }));

	expect(result.status).toBe('none');
	if (result.status !== 'none') return;
	expect(result.headers.get('accept')).toBe('application/json');
});
