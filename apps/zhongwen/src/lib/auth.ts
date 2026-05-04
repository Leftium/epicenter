import { BearerSession } from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

export const session = createPersistedState({
	key: 'zhongwen:authSession',
	schema: BearerSession.or('null'),
	defaultValue: null,
});
