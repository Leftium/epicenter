import { nanoid } from 'nanoid/non-secure';
import type { Result } from 'wellcrafted/result';
import {
	executeTransformation,
	type TransformError,
} from '$lib/operations/transform';
import type { Transformation } from '$lib/workspace';

/**
 * One in-memory candidate: running a single transformation over a shared `input`.
 * Its `result` promise is already running on creation and resolves independently,
 * so the UI can render per-card loading and fill each card in as it completes
 * (via `{#await candidate.result}`). Candidates are never persisted; only the one
 * the user accepts becomes a run.
 */
export type Candidate = {
	/** Stable key for list rendering; not a workspace id. */
	id: string;
	transformation: Transformation;
	input: string;
	result: Promise<Result<string, TransformError>>;
};

/**
 * Start one transformation over `input` and return its candidate. The `result`
 * promise is already running on return; nothing here touches the workspace. The
 * picker creates these one id at a time as chips toggle on, so the unit is a
 * single candidate, not a batch.
 */
export function createCandidate({
	input,
	transformation,
}: {
	input: string;
	transformation: Transformation;
}): Candidate {
	return {
		id: nanoid(),
		transformation,
		input,
		result: executeTransformation({ input, transformation }),
	};
}
