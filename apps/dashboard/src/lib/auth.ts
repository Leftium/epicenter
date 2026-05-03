import {
	createAuth,
	createSessionStorageAdapter,
	Session,
} from '@epicenter/auth-svelte';
import { createPersistedState } from '@epicenter/svelte';

const session = createPersistedState({
	key: 'dashboard:authSession',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: window.location.origin,
	sessionStorage: createSessionStorageAdapter(session),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
