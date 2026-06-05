import { describe, expect, test } from 'bun:test';
import { Format } from 'typebox/format';
import * as Schema from 'typebox/schema';
import { registerFormats } from './schema';

describe('format registration (the enforcement gate)', () => {
	// The whole point of registering `uri` / `date-time`: an UNREGISTERED format
	// is treated by TypeBox as "always passes", so without registration `url` /
	// `datetime` would silently accept every string. This proves the mechanism on a
	// throwaway format name we control.
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
