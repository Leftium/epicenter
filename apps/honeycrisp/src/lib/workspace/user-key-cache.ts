import type { UserKeyCache } from '@epicenter/workspace';

const STORAGE_KEY = 'honeycrisp:encryption-key';

export const userKeyCache: UserKeyCache = {
	async save(userKeyBase64) {
		sessionStorage.setItem(STORAGE_KEY, userKeyBase64);
	},

	async load() {
		return sessionStorage.getItem(STORAGE_KEY);
	},

	async clear() {
		sessionStorage.removeItem(STORAGE_KEY);
	},
};
