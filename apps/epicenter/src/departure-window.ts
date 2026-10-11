/**
 * This window's side of the departure wire over Tauri, imported as
 * `@epicenter/epicenter/departure/window`. Only a page's Epicenter host
 * build imports it; a browser build has no port.
 *
 * Nudges and the host's stop are heard on this window only, so the other
 * participant's nudges are not heard. Focus is this window's own. Statuses
 * are read strictly; a malformed one throws, and the client reads again
 * rather than act on it. Creating the port registers nothing; the page's
 * `start` does.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DeparturePort } from './departure-page.svelte.js';
import {
	DEPARTURE_ANSWER_COMMAND,
	DEPARTURE_CHANGED_EVENT,
	DEPARTURE_STATUS_COMMAND,
	HOST_STOPPED_EVENT,
	parseDepartureStatus,
} from './departure-wire.js';

export function createWindowDeparturePort(): DeparturePort {
	return {
		async listen({ changed, focused, hostStopped }) {
			const window = getCurrentWebviewWindow();
			const stops: (() => void)[] = [];
			const stopAll = () => {
				for (const stop of stops.splice(0)) stop();
			};
			try {
				stops.push(
					await window.listen(DEPARTURE_CHANGED_EVENT, () => changed()),
				);
				stops.push(
					await window.listen(HOST_STOPPED_EVENT, () => hostStopped()),
				);
				stops.push(
					await window.onFocusChanged(({ payload: isFocused }) => {
						if (isFocused) focused();
					}),
				);
			} catch (cause) {
				stopAll();
				throw cause;
			}
			return stopAll;
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
}
