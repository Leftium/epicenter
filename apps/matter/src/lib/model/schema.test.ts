import { describe, expect, test } from 'bun:test';
import { Format } from 'typebox/format';
import * as Schema from 'typebox/schema';
import { deriveKind, registerFormats } from './schema';

describe('format registration (the enforcement gate)', () => {
	// The whole point of registering `uri` / `date-time`: an UNREGISTERED format
	// is treated by TypeBox as "always passes", so without registration
	// `column.url` / `column.dateTime` would silently accept every string. This
	// proves the mechanism on a throwaway format name we control.
	test('an unregistered format accepts garbage; registering makes it enforce', () => {
		const fmt = 'matter-test-format';
		const schema = { type: 'string', format: fmt } as const;
		expect(Format.Has(fmt)).toBe(false);

		// Unregistered: garbage passes.
		expect(Schema.Compile(schema).Check('garbage')).toBe(true);

		// Register: only the allowed value passes.
		Format.Set(fmt, (v) => v === 'ok');
		expect(Schema.Compile(schema).Check('garbage')).toBe(false);
		expect(Schema.Compile(schema).Check('ok')).toBe(true);

		Format.Set(fmt, () => true); // leave it permissive; clear is not exported per-key
	});

	test('uri and date-time are registered and actually enforce', () => {
		registerFormats(); // idempotent
		const url = Schema.Compile({ type: 'string', format: 'uri' });
		expect(url.Check('https://example.com')).toBe(true);
		expect(url.Check('not a url with spaces')).toBe(false);

		const dt = Schema.Compile({ type: 'string', format: 'date-time' });
		expect(dt.Check('2026-06-04T10:30:00Z')).toBe(true);
		expect(dt.Check('2026-06-04')).toBe(false); // bare date is not a full instant
	});
});

describe('deriveKind (schema -> UI kind, ordered shape match)', () => {
	test('scalar kinds', () => {
		expect(deriveKind({ type: 'string' })).toEqual({ kind: 'string', nullable: false });
		expect(deriveKind({ type: 'boolean' })).toEqual({ kind: 'boolean', nullable: false });
		expect(deriveKind({ type: 'integer' })).toEqual({ kind: 'integer', nullable: false });
		expect(deriveKind({ type: 'number' })).toEqual({ kind: 'number', nullable: false });
	});

	test('format-bearing strings', () => {
		expect(deriveKind({ type: 'string', format: 'uri' })).toEqual({ kind: 'url', nullable: false });
		expect(deriveKind({ type: 'string', format: 'date-time' })).toEqual({
			kind: 'datetime',
			nullable: false,
		});
	});

	test('enum keyword wins over type (single select)', () => {
		expect(deriveKind({ type: 'string', enum: ['a', 'b'] })).toEqual({
			kind: 'select',
			nullable: false,
		});
	});

	// The two recognized list shapes. A string array is `tags`; an array whose
	// items carry an `enum` set is `multiSelect`, and that more specific shape is
	// matched first. Neither derives an element kind: the item shape alone decides.
	test('a string array derives to tags', () => {
		expect(deriveKind({ type: 'array', items: { type: 'string' } })).toEqual({
			kind: 'tags',
			nullable: false,
		});
	});

	test('an enum-item array derives to multiSelect', () => {
		expect(
			deriveKind({ type: 'array', items: { enum: ['a', 'b'] } }),
		).toEqual({ kind: 'multiSelect', nullable: false });
	});

	// The refusal: an array of anything other than strings/enums is not in the
	// closed palette. It falls to the json floor, which model.ts rejects to the
	// raw view rather than rendering a recursive widget.
	test('an array of objects is not a list kind; it falls to json', () => {
		expect(
			deriveKind({ type: 'array', items: { type: 'object' } }).kind,
		).toBe('json');
	});

	test('nullable wrapper unwraps and flags', () => {
		const nullableUrl = {
			anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }],
		};
		expect(deriveKind(nullableUrl)).toEqual({ kind: 'url', nullable: true });
	});

	test('an unrecognized shape falls back to json', () => {
		expect(deriveKind({ type: 'object' }).kind).toBe('json');
		// A true multi-branch union (not the nullable shape) is json.
		expect(
			deriveKind({ anyOf: [{ type: 'string' }, { type: 'integer' }] }).kind,
		).toBe('json');
	});

	test('nullable detection lives in deriveKind (the sole null-branch reader)', () => {
		expect(deriveKind({ type: 'string' }).nullable).toBe(false);
		expect(
			deriveKind({ anyOf: [{ type: 'string' }, { type: 'null' }] }).nullable,
		).toBe(true);
		// A real multi-branch union is not the nullable shape.
		expect(
			deriveKind({ anyOf: [{ type: 'string' }, { type: 'integer' }] }).nullable,
		).toBe(false);
	});
});
