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
 * Fan one input out across the given transformations, one candidate each, as
 * independent parallel completions. Each candidate's `result` promise is already
 * running on return; nothing here touches the workspace.
 */
export function fanOutCandidates({
	input,
	transformations,
}: {
	input: string;
	transformations: Transformation[];
}): Candidate[] {
	return transformations.map((transformation) => ({
		id: nanoid(),
		transformation,
		input,
		result: executeTransformation({ input, transformation }),
	}));
}
