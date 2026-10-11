/**
 * The Epicenter host leaf of the departure seam: this window's side of the
 * host's departure wire, over Tauri (`@epicenter/epicenter/departure/window`).
 * Imports register nothing; the page starts listening when it mounts.
 */
import type { DeparturePort } from '@epicenter/epicenter/departure/page';
import { createWindowDeparturePort } from '@epicenter/epicenter/departure/window';

export const departurePort: DeparturePort | undefined =
	createWindowDeparturePort();
