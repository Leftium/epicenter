/**
 * Autumn adapter translation tests.
 *
 * After the boundary cleanup there is no provider status or machine `code` to
 * branch on: any thrown provider failure collapses to one opaque
 * `BillingError.ProviderRequestFailed` whose message is the error's message.
 * These pin that total mapping and the `isAutumnError` discriminator that lets
 * route `onError` rethrow real bugs.
 */

import { AutumnError } from 'autumn-js';
import { expect, test } from 'bun:test';
import { isAutumnError, mapAutumnError } from './autumn.js';

function makeAutumnError(message: string, body: string): AutumnError {
	return new AutumnError(message, {
		response: new Response(body, { status: 500 }),
		request: new Request('https://api.useautumn.com/check'),
		body,
	});
}

test('an AutumnError maps to ProviderRequestFailed carrying its message', () => {
	const { error } = mapAutumnError(
		makeAutumnError('Autumn API error', '{"code":"server_error"}'),
	);
	expect(error).toMatchObject({
		name: 'ProviderRequestFailed',
		message: 'Autumn API error',
	});
});

test('a non-AutumnError throw (network failure) maps the same way, fail closed', () => {
	const { error } = mapAutumnError(new TypeError('network down'));
	expect(error).toMatchObject({
		name: 'ProviderRequestFailed',
		message: 'network down',
	});
});

test('isAutumnError narrows provider failures from programming bugs', () => {
	expect(isAutumnError(makeAutumnError('x', 'x'))).toBe(true);
	expect(isAutumnError(new Error('a bug in a handler'))).toBe(false);
	expect(isAutumnError('500 Internal Server Error')).toBe(false);
});
