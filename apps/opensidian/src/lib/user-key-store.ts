import { createIndexedDbKeyStore } from '@epicenter/svelte-utils';

export const userKeyStore = createIndexedDbKeyStore('opensidian:encryption-key');
