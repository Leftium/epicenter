/**
 * Tab Manager workspace client — e2e test fixture.
 *
 * Imports the real factory from the tab-manager app, proving that the
 * CLI can load a workspace exported by an actual Epicenter app.
 *
 * Unlike the honeycrisp fixture (which inlines its schema), this
 * fixture uses the real app's workspace factory to test cross-package
 * config loading.
 */

import { createTabManagerWorkspace } from '@epicenter/tab-manager/workspace';

export const tabManager = createTabManagerWorkspace();
