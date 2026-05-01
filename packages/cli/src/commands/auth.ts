/**
 * `epicenter auth`: manage authentication with Epicenter servers.
 *
 * Uses the RFC 8628 device code flow: the CLI prints a URL and one-time code,
 * the user approves in a browser, and the CLI picks up the session automatically.
 *
 * Credentials are stored in `$EPICENTER_HOME/auth/credentials.json`.
 *
 * Server URL is a positional with a default (`https://api.epicenter.so`).
 * Self-hosters pass their own URL; everyone else omits it.
 */

import {
	createAuthServerClient,
	createCliAuth,
	createDefaultCredentialStore,
	type CredentialStore,
	type CredentialStoreStorageMode,
} from '@epicenter/auth/node';
import { cmd } from '../util/cmd.js';

const DEFAULT_SERVER = 'https://api.epicenter.so';

function createAuthForServer(
	serverOrigin: string,
	storageMode: CredentialStoreStorageMode = 'osKeychain',
	credentialStore: CredentialStore = createDefaultCredentialStore({ storageMode }),
) {
	return createCliAuth({
		authServerClient: createAuthServerClient(
			{ fetch },
			{ serverOrigin },
		),
		credentialStore,
	});
}

function displayName(credential: {
	session: { user: { name?: string | null; email: string } };
}) {
	return credential.session.user.name ?? credential.session.user.email;
}

/**
 * `auth` command group.
 *
 * @example
 * ```bash
 * epicenter auth login                             # defaults to api.epicenter.so
 * epicenter auth login https://self-hosted.com     # self-hosted override
 * epicenter auth status
 * epicenter auth logout
 * ```
 */
const loginCommand = cmd({
	command: 'login [server]',
	describe: 'Log in to an Epicenter server (opens browser)',
	builder: (yargs) =>
		yargs
			.positional('server', {
				type: 'string',
				describe: `Server URL (default: ${DEFAULT_SERVER})`,
			})
			.option('secure-storage', {
				type: 'boolean',
				describe: 'Store credential secrets in the OS keychain',
			})
			.option('insecure-storage', {
				type: 'boolean',
				describe: 'Store credential secrets in a plaintext owner-only file',
			})
			.conflicts('secure-storage', 'insecure-storage'),
	handler: async (argv) => {
		const serverUrl =
			typeof argv.server === 'string' && argv.server.length > 0
				? argv.server
				: DEFAULT_SERVER;
		const storageMode: CredentialStoreStorageMode = argv.insecureStorage
			? 'file'
			: 'osKeychain';

		if (storageMode === 'file') {
			console.warn(
				'Warning: storing bearer tokens and encryption keys in a plaintext owner-only file.',
			);
		}

		const cliAuth = createAuthForServer(serverUrl, storageMode);
		const result = await cliAuth.loginWithDeviceCode({
			onDeviceCode: ({ verificationUriComplete, userCode }) => {
				console.log(`\nVisit: ${verificationUriComplete}`);
				console.log(`Enter code: ${userCode}\n`);
			},
		});

		console.log(`✓ Logged in as ${displayName(result.credential)}`);
	},
});

const logoutCommand = cmd({
	command: 'logout [server]',
	describe: 'Log out from an Epicenter server (default: most recent session)',
	builder: (yargs) =>
		yargs.positional('server', {
			type: 'string',
			describe: 'Server URL (default: most recent session)',
		}),
	handler: async (argv) => {
		const server = typeof argv.server === 'string' ? argv.server : undefined;
		const credentialStore = createDefaultCredentialStore();
		const current = server ? null : await credentialStore.getCurrent();
		const cliAuth = createAuthForServer(
			server ?? current?.serverOrigin ?? DEFAULT_SERVER,
			'osKeychain',
			credentialStore,
		);
		const result = await cliAuth.logout(server);

		if (result.status === 'signedOut') {
			console.log('No active session.');
			return;
		}

		console.log('✓ Logged out.');
	},
});

const statusCommand = cmd({
	command: 'status [server]',
	describe: 'Show current authentication status (default: most recent session)',
	builder: (yargs) =>
		yargs.positional('server', {
			type: 'string',
			describe: 'Server URL (default: most recent session)',
		}),
	handler: async (argv) => {
		const server = typeof argv.server === 'string' ? argv.server : undefined;
		const credentialStore = createDefaultCredentialStore();
		const current = server ? null : await credentialStore.getCurrent();
		const cliAuth = createAuthForServer(
			server ?? current?.serverOrigin ?? DEFAULT_SERVER,
			'osKeychain',
			credentialStore,
		);
		const result = await cliAuth.status(server);

		if (result.status === 'signedOut') {
			console.log('Not logged in.');
			return;
		}
		if (result.status === 'missingSecrets') {
			if (result.metadata === null) {
				console.log('Not logged in.');
				return;
			}
			console.log(
				`Logged in as: ${result.metadata.session.user.name} (${result.metadata.session.user.email})`,
			);
			console.log(`Server:       ${result.metadata.serverOrigin}`);
			console.log('Session:      missing local secrets');
			console.warn('Warning: Credential metadata exists, but keychain secrets are missing.');
			return;
		}

		const { credential } = result;
		console.log(
			`Logged in as: ${displayName(credential)} (${credential.session.user.email})`,
		);
		console.log(`Server:       ${credential.serverOrigin}`);
		if (result.status === 'valid') {
			console.log('Session:      valid');
		} else if (result.status === 'expired') {
			console.log('Session:      expired');
		} else {
			console.log('Session:      stored');
			console.warn('Warning: Could not verify session with remote server.');
		}
		console.log(
			`Expires at:   ${new Date(credential.session.session.expiresAt).toLocaleString()}`,
		);
	},
});

export const authCommand = cmd({
	command: 'auth <subcommand>',
	describe: 'Manage authentication with Epicenter servers',
	builder: (yargs) =>
		yargs
			.command(loginCommand)
			.command(logoutCommand)
			.command(statusCommand)
			.demandCommand(1, 'Specify a subcommand: login, logout, or status'),
	handler: () => {},
});
