/**
 * Sync Control Tests
 *
 * Verifies the small composition helper used by browser app factories when
 * they expose one app-level sync control to auth lifecycle binding.
 *
 * Key behaviors:
 * - Pause fans out to every non-null control.
 * - Reconnect fans out to every non-null control.
 * - Null controls are ignored for no-sync scopes.
 */

import { expect, test } from 'bun:test';
import { composeSyncControls } from './sync-control.js';

function createSyncControl() {
	const calls: string[] = [];
	return {
		calls,
		syncControl: {
			pause() {
				calls.push('pause');
			},
			reconnect() {
				calls.push('reconnect');
			},
		},
	};
}

test('composeSyncControls fans out to non-null controls', () => {
	const one = createSyncControl();
	const two = createSyncControl();
	const syncControl = composeSyncControls(
		one.syncControl,
		null,
		two.syncControl,
	);

	syncControl.pause();
	syncControl.reconnect();

	expect(one.calls).toEqual(['pause', 'reconnect']);
	expect(two.calls).toEqual(['pause', 'reconnect']);
});
