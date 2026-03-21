import { createTokenStore } from '@epicenter/svelte/auth-state';

/** Single token store instance shared by auth and workspace sync. */
export const tokenStore = createTokenStore('opensidian');
