import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import {
	createSessionStore,
	type SessionStore,
} from './session-store.js';

export type CreateSessionTokenGetterOptions = {
	serverUrl?: string;
	sessions?: SessionStore;
};

export function createSessionTokenGetter({
	serverUrl = EPICENTER_API_URL,
	sessions = createSessionStore(),
}: CreateSessionTokenGetterOptions = {}) {
	return async () => (await sessions.load(serverUrl))?.accessToken ?? null;
}
