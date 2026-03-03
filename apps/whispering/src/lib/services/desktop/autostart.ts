import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';

export const AutostartError = defineErrors({
	Service: ({ operation, cause }: {
		operation: 'check' | 'enable' | 'disable';
		cause: unknown;
	}) => ({
		message: `Failed to ${operation} autostart: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
});
export type AutostartError = InferErrors<typeof AutostartError>;

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
				AutostartError.Service({
					operation: 'check',
					cause: error,
				}),
		}),

	/** Enable autostart so Whispering launches on system login. */
	enable: () =>
		tryAsync({
			try: () => enable(),
			catch: (error) =>
				AutostartError.Service({
					operation: 'enable',
					cause: error,
				}),
		}),

	/** Disable autostart so Whispering does not launch on system login. */
	disable: () =>
		tryAsync({
			try: () => disable(),
			catch: (error) =>
				AutostartError.Service({
					operation: 'disable',
					cause: error,
				}),
		}),
};

export type AutostartService = typeof AutostartServiceLive;
