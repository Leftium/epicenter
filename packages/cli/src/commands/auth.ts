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
	createMachineAuth,
	type MachineCredentialStoragePolicy,
	type MachineCredentialSummary,
} from '@epicenter/auth/node';
import { cmd } from '../util/cmd.js';

const DEFAULT_SERVER = 'https://api.epicenter.so';

function displayName(credential: MachineCredentialSummary) {
	return credential.user.name ?? credential.user.email;
}

function failAuthCommand(error: { message: string }) {
	console.error(error.message);
	process.exitCode = 1;
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
			.option('insecure-storage', {
				type: 'boolean',
				describe: 'Store credential secrets in a plaintext owner-only file',
			}),
	handler: async (argv) => {
		const serverUrl =
			typeof argv.server === 'string' && argv.server.length > 0
				? argv.server
				: DEFAULT_SERVER;
		const credentialStorage: MachineCredentialStoragePolicy =
			argv.insecureStorage ? { kind: 'plaintextFile' } : { kind: 'keychain' };

		if (credentialStorage.kind === 'plaintextFile') {
			console.warn(
				'Warning: storing bearer tokens and encryption keys in a plaintext owner-only file.',
			);
		}

		const machineAuth = createMachineAuth({ fetch, credentialStorage });
		const result = await machineAuth.loginWithDeviceCode({
			serverOrigin: serverUrl,
			onDeviceCode: ({ verificationUriComplete, userCode }) => {
				console.log(`\nVisit: ${verificationUriComplete}`);
				console.log(`Enter code: ${userCode}\n`);
			},
		});
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		console.log(`✓ Logged in as ${displayName(result.data.credential)}`);
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
		const machineAuth = createMachineAuth({ fetch });
		const result = await machineAuth.logout({ serverOrigin: server });
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		if (result.data.status === 'signedOut') {
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
		const machineAuth = createMachineAuth({ fetch });
		const result = await machineAuth.status({ serverOrigin: server });
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		if (result.data.status === 'signedOut') {
			console.log('Not logged in.');
			return;
		}
		if (result.data.status === 'missingSecrets') {
			console.log(
				`Logged in as: ${displayName(result.data.credential)} (${result.data.credential.user.email})`,
			);
			console.log(`Server:       ${result.data.credential.serverOrigin}`);
			console.log('Session:      missing local secrets');
			console.warn(
				'Warning: Credential metadata exists, but keychain secrets are missing.',
			);
			return;
		}

		const { credential } = result.data;
		console.log(
			`Logged in as: ${displayName(credential)} (${credential.user.email})`,
		);
		console.log(`Server:       ${credential.serverOrigin}`);
		if (result.data.status === 'valid') {
			console.log('Session:      valid');
		} else if (result.data.status === 'expired') {
			console.log('Session:      expired');
		} else {
			console.log('Session:      stored');
			console.warn('Warning: Could not verify session with remote server.');
		}
		console.log(
			`Expires at:   ${new Date(credential.session.expiresAt).toLocaleString()}`,
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
