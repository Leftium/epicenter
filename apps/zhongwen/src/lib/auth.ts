import { AuthSession } from '@epicenter/auth-svelte';
import { createPersistedState, fromPersistedState } from '@epicenter/svelte';

const sessionState = createPersistedState({
	key: 'zhongwen:authSession',
	schema: AuthSession.or('null'),
	defaultValue: null,
});
export const session = fromPersistedState(sessionState);
