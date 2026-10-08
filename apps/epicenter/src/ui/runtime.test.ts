/**
 * What Home says about an app's data. Presence is what the folder shows;
 * nothing claims how the data got there.
 */
import { expect, test } from 'bun:test';
import { type ApplicationData, applicationDataLabel } from './runtime.ts';

test('each data state has the line Home shows, and a present folder is only available locally', () => {
	const cases: [ApplicationData, string | null][] = [
		[{ state: 'compiled' }, null],
		[{ state: 'local' }, null],
		[{ state: 'available' }, 'Available locally'],
		[
			{ state: 'not-downloaded' },
			"Download data to this device to open the app.",
		],
		[{ state: 'downloading' }, "Downloading this app's data from your account."],
		[
			{ state: 'unclaimed', message: 'Move the folder somewhere else, then download.' },
			'Move the folder somewhere else, then download.',
		],
	];
	for (const [data, expected] of cases) expect(applicationDataLabel(data)).toBe(expected);
	for (const [data] of cases)
		expect(applicationDataLabel(data) ?? '').not.toMatch(/downloaded\b/i);
});
