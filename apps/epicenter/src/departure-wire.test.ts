/**
 * The departure status a page reads, checked against the fixture the Rust
 * serializer is also tested against (`src-tauri/src/departure.rs`). Imported
 * through the package subpath the app pages use.
 */
import { expect, test } from 'bun:test';
import { parseDepartureStatus } from '@epicenter/epicenter/departure';
import fixture from './departure-wire.fixture.json';

test('every status Rust can send parses exactly', () => {
	for (const status of fixture.valid)
		expect(parseDepartureStatus(status)).toEqual(status as never);
});

test('a status with a missing, extra, or unknown field is refused', () => {
	for (const status of fixture.invalid)
		expect(() => parseDepartureStatus(status)).toThrow();
});
