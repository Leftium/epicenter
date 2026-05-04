import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok } from 'wellcrafted/result';
import { type BearerSession } from '../auth-types.js';
import { type AuthClient, createBearerAuth } from '../create-auth.js';
import {
	createMachineAuthTransport,
	DeviceTokenError,
	type MachineAuthTransport,
} from './machine-auth-transport.js';
import {
	loadMachineSession,
	saveMachineSession,
} from './machine-session-store.js';

type MachineSessionSummary = {
	user: Pick<BearerSession['user'], 'id' | 'name' | 'email'>;
};

function sessionSummary(session: BearerSession): MachineSessionSummary {
	return {
		user: {
			id: session.user.id,
			name: session.user.name,
			email: session.user.email,
		},
	};
}

/**
 * Start Better Auth device-code login and save the resulting session.
 */
export async function loginWithDeviceCode({
	transport = createMachineAuthTransport(),
	sleep = Bun.sleep,
	backend = Bun.secrets,
	onDeviceCode,
}: {
	transport?: MachineAuthTransport;
	sleep?: (ms: number) => Promise<void>;
	backend?: typeof Bun.secrets;
	onDeviceCode?: (device: {
		userCode: string;
		verificationUriComplete: string;
	}) => void | Promise<void>;
} = {}) {
	const { data: code, error: codeError } =
		await transport.requestDeviceCode();
	if (codeError) return Err(codeError);

	const device = {
		userCode: code.user_code,
		verificationUriComplete: code.verification_uri_complete,
	};
	await onDeviceCode?.(device);

	let interval = code.interval * 1000;
	const deadline = Date.now() + code.expires_in * 1000;
	let accessToken: string | null = null;
	while (Date.now() < deadline) {
		await sleep(interval);
		const { data: poll, error: pollError } =
			await transport.pollDeviceToken({ deviceCode: code.device_code });
		if (pollError) return Err(pollError);
		if (poll.status === 'success') {
			accessToken = poll.accessToken;
			break;
		}
		if (poll.status === 'slowDown') interval += 5_000;
	}
	if (accessToken === null) {
		return DeviceTokenError.DeviceCodeExpired();
	}

	const { data: remote, error: fetchError } = await transport.fetchSession({
		token: accessToken,
	});
	if (fetchError) return Err(fetchError);

	const { error: saveError } = await saveMachineSession(remote.session, {
		backend,
	});
	if (saveError) return Err(saveError);

	return Ok({
		status: 'loggedIn' as const,
		session: sessionSummary(remote.session),
		device,
	});
}

/**
 * Read the saved session and verify it remotely when possible. Network
 * failures surface as `unverified`, not `Err`, so the CLI can show the cached
 * identity even when offline.
 */
export async function status({
	transport = createMachineAuthTransport(),
	backend = Bun.secrets,
	log = createLogger('machine-auth'),
}: {
	transport?: MachineAuthTransport;
	backend?: typeof Bun.secrets;
	log?: Logger;
} = {}) {
	const { data: session, error: loadError } = await loadMachineSession({
		backend,
		log,
	});
	if (loadError) return Err(loadError);
	if (session === null) return Ok({ status: 'signedOut' as const });

	const { data: remote, error: fetchError } = await transport.fetchSession({
		token: session.token,
	});
	if (fetchError) {
		return Ok({
			status: 'unverified' as const,
			session: sessionSummary(session),
			verificationError: fetchError,
		});
	}

	const { error: saveError } = await saveMachineSession(remote.session, {
		backend,
	});
	if (saveError) return Err(saveError);
	return Ok({
		status: 'valid' as const,
		session: sessionSummary(remote.session),
	});
}

export async function logout({
	transport = createMachineAuthTransport(),
	backend = Bun.secrets,
	log = createLogger('machine-auth'),
}: {
	transport?: MachineAuthTransport;
	backend?: typeof Bun.secrets;
	log?: Logger;
} = {}) {
	const { data: session, error: loadError } = await loadMachineSession({
		backend,
		log,
	});
	if (loadError) return Err(loadError);
	if (session === null) return Ok({ status: 'signedOut' as const });

	const { error: signOutError } = await transport.signOut({
		token: session.token,
	});
	if (signOutError) {
		log.warn(signOutError);
	}

	const { error: saveError } = await saveMachineSession(null, { backend });
	if (saveError) return Err(saveError);
	return Ok({ status: 'loggedOut' as const });
}

/**
 * Create an auth client backed by saved machine auth.
 *
 * Storage failures are propagated; daemons should crash rather than silently
 * boot signed-out when the keychain is unreadable.
 */
export async function createMachineAuthClient(): Promise<AuthClient> {
	const log = createLogger('machine-auth');
	const { data: initialSession, error } = await loadMachineSession();
	if (error) throw error;
	return createBearerAuth({
		baseURL: EPICENTER_API_URL,
		initialSession,
		saveSession: async (next) => {
			const { error: saveError } = await saveMachineSession(next);
			if (saveError) {
				log.error(saveError);
			}
		},
	});
}
