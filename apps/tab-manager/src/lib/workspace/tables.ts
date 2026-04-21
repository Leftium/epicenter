/** Type alias for the tab-manager workspace's tables helper. */

import type { tabManager } from './definition';

export type Tables = ReturnType<typeof tabManager.open>['tables'];
