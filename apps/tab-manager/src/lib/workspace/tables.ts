/** Type alias for the tab-manager workspace's tables helper. */

import type { Tables as TablesHelper } from '@epicenter/workspace';
import type { tabManagerTables } from './definition';

export type Tables = TablesHelper<typeof tabManagerTables>;
