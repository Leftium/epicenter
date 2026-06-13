import type { TransformationRunResult } from '$lib/workspace';

/**
 * How long a run with no terminal result still reads as "running". Past this,
 * a resultless run is treated as interrupted: the process that was executing it
 * died before writing an outcome.
 *
 * Liveness is derived here, never stored. The process doing the work already
 * holds it; a crash leaves the result absent, and this window lets the row
 * self-heal to "interrupted" instead of wedging at "running" forever. See
 * docs/articles/20260612T190745-liveness-belongs-to-the-process-not-the-row.md.
 *
 * Generous on purpose: a transformation is a chain of LLM calls, so the live
 * window comfortably covers the slowest realistic run.
 */
const RUNNING_GRACE_MS = 5 * 60 * 1000;

export type DerivedRunStatus =
	| 'running'
	| 'interrupted'
	| 'completed'
	| 'failed';

/**
 * Derive a run or step run's status from its stored result and start time. A
 * present result is terminal. An absent result is live within the grace window
 * and interrupted after it.
 */
export function deriveRunStatus(
	run: { startedAt: string; result: TransformationRunResult | null },
	nowMs: number = Date.now(),
): DerivedRunStatus {
	if (run.result) return run.result.status;
	const ageMs = nowMs - new Date(run.startedAt).getTime();
	return ageMs < RUNNING_GRACE_MS ? 'running' : 'interrupted';
}
