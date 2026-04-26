import { AuthSession } from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

export const session = createPersistedState({
	key: 'zhongwen:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});
