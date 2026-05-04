import { Session } from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

export const session = createPersistedState({
	key: 'zhongwen:authSession',
	schema: Session.or('null'),
	defaultValue: null,
});
