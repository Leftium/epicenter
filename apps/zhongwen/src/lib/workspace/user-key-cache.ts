import { createIndexedDbKeyCache } from '@epicenter/svelte-utils';

export const userKeyCache = createIndexedDbKeyCache('zhongwen:encryption-key');
