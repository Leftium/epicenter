/**
 * Expected-value tests: loaded fields project to serializable values and readable phrases.
 * Enum kinds carry their members; scalar and reference kinds reduce to their names.
 * Fields use the same contract validation as the report and integrity panel.
 */

import { describe, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import type { Field } from '../field/index.js';
import { validateContract } from './contract.js';
import { describeExpected, formatExpected } from './expected.js';

/** Recognize one at-rest field schema into a loaded {@link Field}. */
function fieldFrom(schema: unknown): Field {
	const data = expectOk(validateContract({ fields: { f: schema } }));
	const [field] = data.fields;
	if (!field) throw new Error('schema was not recognized as a field');
	return field;
}

describe('expected values and phrases', () => {
	test('a scalar kind reduces to its name', () => {
		for (const kind of ['string', 'integer', 'boolean'] as const) {
			const expected = describeExpected(fieldFrom({ type: kind }));
			expect(expected).toEqual({ kind });
			expect(formatExpected(expected)).toBe(kind);
		}
	});

	test('a reference reduces to its name (no target table leaks in)', () => {
		const expected = describeExpected(
			fieldFrom({ type: 'string', 'x-ref': 'pages' }),
		);
		expect(expected).toEqual({ kind: 'reference' });
		expect(formatExpected(expected)).toBe('reference');
	});

	test('select carries its enum members', () => {
		const expected = describeExpected(
			fieldFrom({ type: 'string', enum: ['draft', 'live'] }),
		);
		expect(expected).toEqual({ kind: 'select', values: ['draft', 'live'] });
		expect(formatExpected(expected)).toBe('one of draft, live');
	});

	test('multiSelect carries its enum members', () => {
		const expected = describeExpected(
			fieldFrom({
				type: 'array',
				items: { type: 'string', enum: ['a', 'b'] },
			}),
		);
		expect(expected).toEqual({ kind: 'multiSelect', values: ['a', 'b'] });
		expect(formatExpected(expected)).toBe('array containing one of a, b');
	});
});
