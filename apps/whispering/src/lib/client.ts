/**
 * Whispering workspace client — single Y.Doc with IndexedDB persistence.
 *
 * Future sync extensions will add remote replication.
 */

import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { createWhispering } from './workspace/workspace';

export const workspace = createWhispering().withExtension('persistence', indexeddbPersistence);
