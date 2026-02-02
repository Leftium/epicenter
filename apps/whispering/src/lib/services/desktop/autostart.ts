import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';

export const { AutostartServiceError, AutostartServiceErr } = createTaggedError(
	'AutostartServiceError',
);
export type AutostartServiceError = ReturnType<typeof AutostartServiceError>;

/**
 * Auto-start service for desktop platforms.
 * Enables/disables launching Whispering on system login.
 *
 * Platform-specific behavior:
 * - macOS: Creates Launch Agent in ~/Library/LaunchAgents/
 * - Windows: Adds registry entry to HKEY_CURRENT_USER\...\Run
 * - Linux: Creates .desktop file in ~/.config/autostart/
 */
export const AutostartServiceLive = {
	/** Check if autostart is currently enabled for Whispering. */
	isEnabled: () =>
		tryAsync({
			try: () => isEnabled(),
			catch: (error) =>
				AutostartServiceErr({
					message: `Failed to check autostart status: ${extractErrorMessage(error)}`,
				}),
		}),

	/** Enable autostart so Whispering launches on system login. */
	enable: () =>
		tryAsync({
			try: () => enable(),
			catch: (error) =>
				AutostartServiceErr({
					message: `Failed to enable autostart: ${extractErrorMessage(error)}`,
				}),
		}),

	/** Disable autostart so Whispering does not launch on system login. */
	disable: () =>
		tryAsync({
			try: () => disable(),
			catch: (error) =>
				AutostartServiceErr({
					message: `Failed to disable autostart: ${extractErrorMessage(error)}`,
				}),
		}),
};

export type AutostartService = typeof AutostartServiceLive;
