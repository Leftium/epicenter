/**
 * What the post-processing choice is now.
 *
 * The choice is a transformation's path, held by the session. The folder is
 * the truth about that transformation: it may have been deleted, or edited
 * into something that cannot run, since it was chosen. This reads the choice
 * against the transformations as last listed and says which it is. Nothing
 * here runs a transformation.
 */
import type { TransformationEntry } from './library.svelte.js';

/** A transformation's title, or its file when the title cannot be read. */
export function transformationName(entry: TransformationEntry): string {
	return entry.fields.title || (entry.stem === '' ? entry.path : entry.stem);
}

/**
 * Whether a transformation holds what a run needs: the prompt and a title,
 * model, and endpoint that each say something. `library.transform` checks
 * the file again when it runs.
 */
export function canRun(entry: TransformationEntry): boolean {
	const { title, model, endpoint } = entry.fields;
	return (
		title !== undefined &&
		Boolean(entry.body?.trim()) &&
		Boolean(model?.trim()) &&
		Boolean(endpoint?.trim())
	);
}

export type PostProcessingChoice =
	| { readonly kind: 'none' }
	| { readonly kind: 'ready'; readonly entry: TransformationEntry }
	/** Chosen and still in the folder, but it lacks something a run needs. */
	| { readonly kind: 'repair'; readonly entry: TransformationEntry }
	/** Chosen, and no longer among the transformations the folder lists. */
	| { readonly kind: 'missing'; readonly path: string };

export function resolvePostProcessing(
	path: string | undefined,
	transformations: readonly TransformationEntry[],
): PostProcessingChoice {
	if (path === undefined) return { kind: 'none' };
	const entry = transformations.find((item) => item.path === path);
	if (entry === undefined) return { kind: 'missing', path };
	return { kind: canRun(entry) ? 'ready' : 'repair', entry };
}
