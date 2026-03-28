import { createIndexedDbKeyCache } from '@epicenter/svelte-utils';

export const userKeyCache = createIndexedDbKeyCache('opensidian:encryption-key');
