/**
 * `epicenter auth` — manage authentication with Epicenter servers.
 *
 * Uses the RFC 8628 device code flow: the CLI prints a URL and one-time code,
 * the user approves in a browser, and the CLI picks up the session automatically.
 *
 * All sessions stored in the unified auth store at `$EPICENTER_HOME/auth/sessions.json`.
 */

import type { Argv, CommandModule } from 'yargs';
import { createAuthApi } from '../auth/api';
import { loginWithDeviceCode } from '../auth/device-flow';
import {
	clearSession,
	loadDefaultSession,
	loadSession,
	normalizeServerUrl,
} from '../auth/store';

function buildLoginCommand(home: string) {
	return {
		command: 'login',
		describe: 'Log in to an Epicenter server (opens browser)',
		builder: (yargs: Argv) =>
			yargs.option('server', {
				type: 'string',
				description: 'Server URL (e.g. https://api.epicenter.so)',
				demandOption: true,
			}),
		handler: async (argv: any) => {
			const serverUrl = normalizeServerUrl(argv.server);
			await loginWithDeviceCode(serverUrl, home);
		},
	};
}

function buildLogoutCommand(home: string) {
	return {
		command: 'logout',
		describe: 'Log out from an Epicenter server',
		builder: (yargs: Argv) =>
			yargs.option('server', {
				type: 'string',
				description:
					'Server URL to log out from (default: most recent session)',
			}),
		handler: async (argv: any) => {
			const session = argv.server
				? await loadSession(home, argv.server)
				: await loadDefaultSession(home);

			if (!session) {
				console.log('No active session.');
				return;
			}

			// Best-effort remote sign-out
			try {
				const api = createAuthApi(session.server, session.accessToken);
				await api.signOut();
			} catch {
				// Remote may be unreachable
			}

			await clearSession(home, session.server);
			console.log('\u2713 Logged out.');
		},
	};
}

function buildStatusCommand(home: string) {
	return {
		command: 'status',
		describe: 'Show current authentication status',
		builder: (yargs: Argv) =>
			yargs.option('server', {
				type: 'string',
				description: 'Server URL to check (default: most recent session)',
			}),
		handler: async (argv: any) => {
			const session = argv.server
				? await loadSession(home, argv.server)
				: await loadDefaultSession(home);

			if (!session) {
				console.log('Not logged in.');
				return;
			}

			const api = createAuthApi(session.server, session.accessToken);

			try {
				const remote = await api.getSession();
				const displayName = remote.user.name ?? remote.user.email;
				console.log(`Logged in as: ${displayName} (${remote.user.email})`);
				console.log(`Server:       ${session.server}`);
				console.log(`Session:      valid`);
				if (remote.session.expiresAt) {
					console.log(
						`Expires at:   ${new Date(remote.session.expiresAt).toLocaleString()}`,
					);
				}
			} catch {
				const displayName =
					session.user?.name ?? session.user?.email ?? '(unknown)';
				console.log(`Logged in as: ${displayName} [stored]`);
				console.log(`Server:       ${session.server}`);
				console.warn('Warning: Could not verify session with remote server.');
			}
		},
	};
}

/**
 * Build the `auth` command group.
 */
export function buildAuthCommand(home: string): CommandModule {
	return {
		command: 'auth <subcommand>',
		describe: 'Manage authentication with Epicenter servers',
		builder: (yargs: Argv) =>
			yargs
				.command(buildLoginCommand(home) as unknown as CommandModule)
				.command(buildLogoutCommand(home) as unknown as CommandModule)
				.command(buildStatusCommand(home) as unknown as CommandModule)
				.demandCommand(1, 'Specify a subcommand: login, logout, or status'),
		handler: () => {},
	};
}
