/**
 * Machine auth API surface for CLI and daemons.
 *
 * Wave 3 replaces this module with the OOB CLI flow per
 * `specs/20260514T120000-machine-auth-oob-clean-break.md`. During Wave 2 the
 * module is stubbed so the package compiles; consumers (the CLI command
 * group and apps/{name}/blocks/daemon-route.ts) will be rewired in Wave 3.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const MachineAuthRequestError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: `Auth transport request failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type MachineAuthRequestError = InferErrors<
	typeof MachineAuthRequestError
>;

const PENDING_WAVE_3 =
	'[machine-auth] CLI flow pending Wave 3 migration to OOB. ' +
	'Run after the schema break to OOB lands. ' +
	'See specs/20260514T120000-machine-auth-oob-clean-break.md.';

export async function loginWithDeviceCode(): Promise<never> {
	throw new Error(PENDING_WAVE_3);
}

export async function status(): Promise<never> {
	throw new Error(PENDING_WAVE_3);
}

export async function logout(): Promise<never> {
	throw new Error(PENDING_WAVE_3);
}

export async function createMachineAuthClient(): Promise<never> {
	throw new Error(PENDING_WAVE_3);
}
