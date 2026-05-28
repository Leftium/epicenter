/**
 * BillingError wire-contract tests.
 *
 * The dashboard receives `BillingError` across an untrusted network boundary
 * and validates the body with `BillingErrorEnvelope` before trusting it. These
 * tests pin the agreement between the two representations of that one contract:
 * the `defineErrors` factory (server constructor) and the arktype schema
 * (client validator). If either drifts, the dashboard silently loses its
 * structured error and these tests fail.
 */

import { expect, test } from 'bun:test';
import { type } from 'arktype';
import { BillingError, BillingErrorEnvelope } from './errors.js';

/** Serialize a value the way Hono's `c.json` does, then parse it back: the
 *  exact transform an envelope undergoes crossing the wire to the dashboard. */
function overTheWire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

test('a serialized BillingError validates and preserves statusCode + code', () => {
	const wire = overTheWire(
		BillingError.ProviderRequestFailed({
			statusCode: 402,
			code: 'insufficient_balance',
			message: 'Not enough credits',
		}),
	);

	const envelope = BillingErrorEnvelope(wire);
	if (envelope instanceof type.errors) {
		throw new Error(`Expected a valid envelope: ${envelope.summary}`);
	}

	expect(envelope.error).toMatchObject({
		name: 'ProviderRequestFailed',
		statusCode: 402,
		code: 'insufficient_balance',
		message: 'Not enough credits',
	});
});

test('the envelope validates when code is absent (JSON drops undefined)', () => {
	const wire = overTheWire(
		BillingError.ProviderRequestFailed({
			statusCode: 503,
			code: undefined,
			message: 'Billing provider unreachable',
		}),
	);

	// `JSON.stringify` drops `code: undefined`, so the wire body has no `code`
	// key at all. The schema treats `code` as optional precisely for this.
	const wireError = (wire as { error: Record<string, unknown> }).error;
	expect('code' in wireError).toBe(false);

	const envelope = BillingErrorEnvelope(wire);
	if (envelope instanceof type.errors) {
		throw new Error(`Expected a valid envelope: ${envelope.summary}`);
	}
	expect(envelope.error.statusCode).toBe(503);
	expect(envelope.error.code).toBeUndefined();
});

test('the envelope rejects bodies that are not the BillingError shape', () => {
	const malformed: unknown[] = [
		null,
		{},
		// missing statusCode + message
		{ data: null, error: { name: 'ProviderRequestFailed' } },
		// wrong discriminant
		{
			data: null,
			error: { name: 'SomethingElse', statusCode: 500, message: 'x' },
		},
		// statusCode is a string, not a number
		{
			data: null,
			error: { name: 'ProviderRequestFailed', statusCode: '500', message: 'x' },
		},
		// envelope-less (no `data: null`): a bare error object
		{ name: 'ProviderRequestFailed', statusCode: 500, message: 'x' },
		// a plain status line, the shape the old duck-check could not catch
		'500 Internal Server Error',
	];

	for (const body of malformed) {
		expect(BillingErrorEnvelope(body) instanceof type.errors).toBe(true);
	}
});
