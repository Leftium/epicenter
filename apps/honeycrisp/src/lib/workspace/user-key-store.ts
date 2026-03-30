import { createIndexedDbKeyStore } from '@epicenter/svelte-utils';

export const userKeyStore = createIndexedDbKeyStore('honeycrisp:encryption-key');
