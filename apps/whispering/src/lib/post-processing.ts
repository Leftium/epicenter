/**
 * What the post-processing choice is now.
 *
 * The choice is a transformation's path, held by the session. The folder is
 * the truth about that transformation: it may have been deleted, or edited
 * into something that cannot run, since it was chosen. This reads the choice
 * against the transformations as last listed and the library's one recipe
 * resolver, and says which it is. Nothing here runs a transformation.
 */
import type { TransformationEntry } from './library.svelte.js';
import type { ResolvedRecipe } from './recipe.js';

/** A transformation's title, or its file when the title cannot be read. */
export function transformationName(entry: TransformationEntry): string {
	return (
		entry.row.fields.title || (entry.stem === '' ? entry.path : entry.stem)
	);
}

export type PostProcessingChoice =
	| { readonly kind: 'none' }
	| { readonly kind: 'ready'; readonly entry: TransformationEntry }
	/** Chosen and still in the folder, but it cannot run now; `reason` says why. */
	| {
			readonly kind: 'repair';
			readonly entry: TransformationEntry;
			readonly reason: string;
	  }
	/** Chosen, and no longer among the transformations the folder lists. */
	| { readonly kind: 'missing'; readonly path: string };

export function resolvePostProcessing(
	path: string | undefined,
	transformations: readonly TransformationEntry[],
	resolve: (recipe: TransformationEntry['row']) => ResolvedRecipe,
): PostProcessingChoice {
	if (path === undefined) return { kind: 'none' };
	const entry = transformations.find((item) => item.path === path);
	if (entry === undefined) return { kind: 'missing', path };
	const resolved = resolve(entry.row);
	return resolved.kind === 'ready'
		? { kind: 'ready', entry }
		: { kind: 'repair', entry, reason: resolved.reason };
}
