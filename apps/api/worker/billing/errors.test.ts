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

test('a serialized BillingError validates and carries the fixed opaque message', () => {
	const wire = overTheWire(BillingError.ProviderRequestFailed());

	const envelope = BillingErrorEnvelope(wire);
	if (envelope instanceof type.errors) {
		throw new Error(`Expected a valid envelope: ${envelope.summary}`);
	}

	expect(envelope.error.name).toBe('ProviderRequestFailed');
	// The message is a fixed user-facing string, never the provider's wording.
	expect(envelope.error.message).toBe(
		'Billing is temporarily unavailable. Please try again.',
	);
});

test('the envelope rejects bodies that are not the BillingError shape', () => {
	const malformed: unknown[] = [
		null,
		{},
		// missing message
		{ data: null, error: { name: 'ProviderRequestFailed' } },
		// wrong discriminant
		{ data: null, error: { name: 'SomethingElse', message: 'x' } },
		// message is a number, not a string
		{ data: null, error: { name: 'ProviderRequestFailed', message: 500 } },
		// envelope-less (no `data: null`): a bare error object
		{ name: 'ProviderRequestFailed', message: 'x' },
		// a plain status line, the shape the old duck-check could not catch
		'500 Internal Server Error',
	];

	for (const body of malformed) {
		expect(BillingErrorEnvelope(body) instanceof type.errors).toBe(true);
	}
});
