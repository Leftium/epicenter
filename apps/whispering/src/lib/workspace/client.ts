/**
 * Whispering workspace client — single Y.Doc with IndexedDB persistence.
 *
 * Future sync extensions will add remote replication.
 */

import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { createWhispering } from './workspace';

export default createWhispering().withExtension('persistence', indexeddbPersistence);
