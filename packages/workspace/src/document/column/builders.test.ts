/**
 * Runtime tests for the workspace's column primitives: the substrate-policy
 * builders the shared `field.*` vocabulary deliberately omits (`nullable`, the
 * emptiness axis; `ianaTimeZone`, a branded format) plus the cross-substrate
 * recognition contract. The portable kinds (`field.string`, `field.select`, ...)
 * are proven in `@epicenter/field`'s own `field.test.ts`; the compile-time
 * `FlatJsonTSchema` tests live in `column.test-d.ts`.
 */

import { field, recognize } from '@epicenter/field';
import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { ianaTimeZone, nullable } from './index';

/** The at-rest form `recognize` reads: a stored schema, with the live `~kind` tag dropped. */
const atRest = (schema: object): unknown => JSON.parse(JSON.stringify(schema));

describe('nullable (the emptiness axis)', () => {
	test('accepts the inner schema value or null', () => {
		const schema = nullable(field.string());
		expect(Value.Check(schema, 'hi')).toBe(true);
		expect(Value.Check(schema, null)).toBe(true);
		expect(Value.Check(schema, 42)).toBe(false);
	});

	test('is outside the palette (degrades to raw): nullability is substrate policy, not a kind', () => {
		expect(recognize(atRest(nullable(field.string())))).toBeNull();
	});
});

describe('ianaTimeZone', () => {
	const schema = ianaTimeZone();

	test('accepts valid IANA zones', () => {
		expect(Value.Check(schema, 'America/New_York')).toBe(true);
		expect(Value.Check(schema, 'UTC')).toBe(true);
	});

	test('rejects invalid zones', () => {
		expect(Value.Check(schema, 'Not/A_Zone')).toBe(false);
		expect(Value.Check(schema, '')).toBe(false);
	});
});

describe('cross-substrate: a workspace column recognizes in matter', () => {
	test('field.json recognizes as the json kind and validates its payload', () => {
		const schema = field.json(Type.Object({ author: Type.String() }));
		expect(recognize(atRest(schema))?.kind).toBe('json');
		expect(Value.Check(schema, { author: 'Braden' })).toBe(true);
		expect(Value.Check(schema, { author: 42 })).toBe(false);
	});
});
