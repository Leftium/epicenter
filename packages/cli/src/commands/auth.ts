/**
 * `epicenter auth`: manage authentication with Epicenter.
 *
 * Uses the RFC 8628 device code flow: the CLI prints a URL and one-time code,
 * the user approves in a browser, and the CLI picks up the session automatically.
 *
 * The local machine session is stored in the OS keychain.
 */

import {
	createMachineAuth,
	type MachineSessionSummary,
} from '@epicenter/auth/node';
import { cmd } from '../util/cmd.js';

function displayName(session: MachineSessionSummary) {
	return session.user.name ?? session.user.email;
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
 * epicenter auth login
 * epicenter auth status
 * epicenter auth logout
 * ```
 */
const loginCommand = cmd({
	command: 'login',
	describe: 'Log in to Epicenter (opens browser)',
	handler: async () => {
		const machineAuth = createMachineAuth({ fetch });
		const result = await machineAuth.loginWithDeviceCode({
			onDeviceCode: ({ verificationUriComplete, userCode }) => {
				console.log(`\nVisit: ${verificationUriComplete}`);
				console.log(`Enter code: ${userCode}\n`);
			},
		});
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		console.log(`✓ Logged in as ${displayName(result.data.session)}`);
	},
});

const logoutCommand = cmd({
	command: 'logout',
	describe: 'Log out from Epicenter',
	handler: async () => {
		const machineAuth = createMachineAuth({ fetch });
		const result = await machineAuth.logout();
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
	command: 'status',
	describe: 'Show current authentication status',
	handler: async () => {
		const machineAuth = createMachineAuth({ fetch });
		const result = await machineAuth.status();
		if (result.error) {
			failAuthCommand(result.error);
			return;
		}

		if (result.data.status === 'signedOut') {
			console.log('Not logged in.');
			return;
		}

		const { session } = result.data;
		console.log(
			`Logged in as: ${displayName(session)} (${session.user.email})`,
		);
		if (result.data.status === 'valid') {
			console.log('Session:      verified');
		} else {
			console.log('Session:      stored, could not verify');
			console.warn('Warning: Could not verify session with the Epicenter API.');
		}
	},
});

export const authCommand = cmd({
	command: 'auth <subcommand>',
	describe: 'Manage authentication with Epicenter',
	builder: (yargs) =>
		yargs
			.command(loginCommand)
			.command(logoutCommand)
			.command(statusCommand)
			.demandCommand(1, 'Specify a subcommand: login, logout, or status'),
	handler: () => {},
});
