import {
	attachAuthSnapshotToWorkspace,
	createAuth,
	createSessionStorageAdapter,
	Session,
} from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { openFuji } from './browser';

const session = createPersistedState({
	key: 'fuji:authSession',
	schema: Session.or('null'),
	defaultValue: null,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	sessionStorage: createSessionStorageAdapter(session),
});

export const fuji = openFuji({
	auth,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Fuji',
		platform: 'web',
	},
});

attachAuthSnapshotToWorkspace({
	auth,
	workspace: fuji,
	onSignedOutLocalDataCleared: () => window.location.reload(),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}
