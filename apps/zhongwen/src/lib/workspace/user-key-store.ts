import { createIndexedDbKeyStore } from '@epicenter/svelte-utils';

export const userKeyStore = createIndexedDbKeyStore('zhongwen:encryption-key');
