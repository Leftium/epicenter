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

test('the factory owns the fixed opaque message', () => {
	// The message is a fixed user-facing string, never the provider's wording.
	// It is owned by the server factory; the client rebuilds it from the same
	// factory rather than reading the wire value.
	expect(BillingError.ProviderRequestFailed().error.message).toBe(
		'Billing is temporarily unavailable. Please try again.',
	);
});

test('a serialized BillingError validates against the envelope', () => {
	const wire = overTheWire(BillingError.ProviderRequestFailed());

	const envelope = BillingErrorEnvelope(wire);
	if (envelope instanceof type.errors) {
		throw new Error(`Expected a valid envelope: ${envelope.summary}`);
	}

	expect(envelope.error.name).toBe('ProviderRequestFailed');
});

test('a billing error that omits its message still validates', () => {
	// The client keys on the discriminant, not the message, so a billing error
	// missing its message must not be misclassified as a generic request failure.
	const envelope = BillingErrorEnvelope({
		data: null,
		error: { name: 'ProviderRequestFailed' },
	});
	expect(envelope instanceof type.errors).toBe(false);
});

test('the envelope rejects bodies that are not the BillingError shape', () => {
	const malformed: unknown[] = [
		null,
		{},
		// wrong discriminant
		{ data: null, error: { name: 'SomethingElse' } },
		// envelope-less (no `data: null`): a bare error object
		{ name: 'ProviderRequestFailed', message: 'x' },
		// a plain status line, the shape the old duck-check could not catch
		'500 Internal Server Error',
	];

	for (const body of malformed) {
		expect(BillingErrorEnvelope(body) instanceof type.errors).toBe(true);
	}
});
