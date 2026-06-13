import { nanoid } from 'nanoid/non-secure';
import type { Result } from 'wellcrafted/result';
import {
	executeTransformation,
	type TransformError,
} from '$lib/operations/transform';
import type { Transformation } from '$lib/workspace';

/**
 * One in-memory candidate: a single (transformation x sample) invocation over a
 * shared `input`. Its `result` promise is already running on creation and
 * resolves independently, so the UI can render per-card loading and fill each
 * card in as it completes (via `{#await candidate.result}`). Candidates are never
 * persisted; only the one the user accepts becomes a run.
 */
export type Candidate = {
	/** Stable key for list rendering; not a workspace id. */
	id: string;
	transformation: Transformation;
	/** 0-based index distinguishing repeated samples of the same transformation. */
	sampleIndex: number;
	input: string;
	result: Promise<Result<string, TransformError>>;
};

/**
 * Fan one input out across `transformations.length x samples` independent
 * parallel completions, returning a flat in-memory bag. Each candidate's `result`
 * promise is already running on return; nothing here touches the workspace.
 *
 * `samples` is an invocation parameter, not a property of any transformation:
 * "n samples of one transformation" and "k transformations on one input" are the
 * same surface with different fan-out math.
 */
export function fanOutCandidates({
	input,
	transformations,
	samples,
}: {
	input: string;
	transformations: Transformation[];
	samples: number;
}): Candidate[] {
	const candidates: Candidate[] = [];
	for (const transformation of transformations) {
		for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
			candidates.push({
				id: nanoid(),
				transformation,
				sampleIndex,
				input,
				result: executeTransformation({ input, transformation }),
			});
		}
	}
	return candidates;
}
