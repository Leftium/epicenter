import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { IS_MACOS } from '$lib/constants/platform';

export const PermissionsError = defineErrors({
	Service: ({ action, permissionType, cause }: {
		action: 'check' | 'request';
		permissionType: 'accessibility' | 'microphone';
		cause: string;
	}) => ({
		message: `Failed to ${action} ${permissionType} permissions: ${cause}`,
		action,
		permissionType,
		cause,
	}),
});
export type PermissionsError = InferErrors<typeof PermissionsError>;

export const PermissionsServiceLive = {
	accessibility: {
		async check() {
			if (!IS_MACOS) return Ok(true);

			return tryAsync({
				try: async () => {
					const { checkAccessibilityPermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await checkAccessibilityPermission();
				},
				catch: (error) =>
					PermissionsError.Service({
						action: 'check',
						permissionType: 'accessibility',
						cause: extractErrorMessage(error),
					}),
			});
		},

		async request() {
			if (!IS_MACOS) return Ok(true);

			return tryAsync({
				try: async () => {
					const { requestAccessibilityPermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await requestAccessibilityPermission();
				},
				catch: (error) =>
					PermissionsError.Service({
						action: 'request',
						permissionType: 'accessibility',
						cause: extractErrorMessage(error),
					}),
			});
		},
	},

	microphone: {
		async check() {
			if (!IS_MACOS) return Ok(true);

			return tryAsync({
				try: async () => {
					const { checkMicrophonePermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await checkMicrophonePermission();
				},
				catch: (error) =>
					PermissionsError.Service({
						action: 'check',
						permissionType: 'microphone',
						cause: extractErrorMessage(error),
					}),
			});
		},

		async request() {
			if (!IS_MACOS) return Ok(true);

			return tryAsync({
				try: async () => {
					const { requestMicrophonePermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await requestMicrophonePermission();
				},
				catch: (error) =>
					PermissionsError.Service({
						action: 'request',
						permissionType: 'microphone',
						cause: extractErrorMessage(error),
					}),
			});
		},
	},
};

export type PermissionsService = typeof PermissionsServiceLive;
