import { createIndexedDbKeyCache } from '@epicenter/svelte-utils';

export const userKeyCache = createIndexedDbKeyCache('honeycrisp:encryption-key');
