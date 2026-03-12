import { defineWorkspace } from '@epicenter/workspace';

/**
 * Headless runner config for the tab-manager workspace.
 *
 * Uses the same workspace ID as the browser extension, so the runner
 * joins the same Y.Doc room on the sync server. Table schemas aren't
 * needed here—persistence and sync operate on raw Y.Doc updates.
 *
 * Run:
 *   EPICENTER_SERVER_URL=wss://api.epicenter.so EPICENTER_TOKEN=<your-token> \
 *     bun run apps/runner -- apps/runner/example
 */
export const tabManager = defineWorkspace({ id: 'tab-manager' });
