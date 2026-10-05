/**
 * The Epicenter host leaf of the departure seam: this window's side of the
 * host's departure wire. Nudges are listened for on this window only, so the
 * other participant's nudges are not heard. Statuses are read strictly; a
 * malformed one throws, and the caller reads again rather than act on it.
 * Imports open nothing; the page starts listening when it mounts.
 */
import {
	DEPARTURE_ANSWER_COMMAND,
	DEPARTURE_CHANGED_EVENT,
	DEPARTURE_STATUS_COMMAND,
	parseDepartureStatus,
} from '@epicenter/epicenter/departure';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DeparturePort } from './types.js';

export const departurePort: DeparturePort | undefined = {
	async listen(onChange, onFocus) {
		const window = getCurrentWebviewWindow();
		const stopChanges = await window.listen(DEPARTURE_CHANGED_EVENT, () =>
			onChange(),
		);
		try {
			const stopFocus = await window.onFocusChanged(({ payload: focused }) => {
				if (focused) onFocus();
			});
			return () => {
				stopChanges();
				stopFocus();
			};
		} catch (cause) {
			stopChanges();
			throw cause;
		}
	},
	async status() {
		return parseDepartureStatus(await invoke(DEPARTURE_STATUS_COMMAND));
	},
	async answer({ generation, round, answer }) {
		return parseDepartureStatus(
			await invoke(DEPARTURE_ANSWER_COMMAND, { generation, round, answer }),
		);
	},
};
