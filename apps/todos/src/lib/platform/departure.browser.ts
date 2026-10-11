/**
 * The browser leaf of the departure seam: no port. Nothing native ends a
 * browser tab, and the page does not guess whether a host is there; leaving
 * the tab keeps its own leave warning. Nothing native is imported here.
 */
import type { DeparturePort } from '@epicenter/epicenter/departure/page';

export const departurePort: DeparturePort | undefined = undefined;
