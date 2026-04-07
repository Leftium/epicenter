/**
 * Line-based manipulation of `epicenter.config.ts`.
 *
 * Removes import+export lines for workspace factories.
 * Uses simple string manipulation—AST parsing is overkill for
 * removing import/export pairs.
 */


/**
 * Remove a workspace import and export from an `epicenter.config.ts` file.
 *
 * Finds lines containing the import path or export name and removes them.
 * Also cleans up the `.withExtension(...)` continuation lines that follow
 * the export.
 *
 * @param content - Current file content.
 * @param importPath - Relative import path to match (e.g., `'./workspaces/my-notes/workspace'`).
 * @param exportName - Export variable name to match (e.g., `myNotes`).
 * @returns Updated file content with matching import and export removed.
 *
 * @example
 * ```typescript
 * const updated = removeWorkspaceFromConfig(
 *   existingContent,
 *   './workspaces/my-notes/workspace',
 *   'myNotes',
 * );
 * ```
 */
export function removeWorkspaceFromConfig(
	content: string,
	importPath: string,
	exportName: string,
): string {
	const lines = content.split('\n');
	const result: string[] = [];
	let skipContinuation = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();

		// Skip import lines matching the path
		if (trimmed.startsWith('import ') && line.includes(importPath)) {
			continue;
		}

		// Skip export lines matching the name
		if (trimmed.startsWith(`export const ${exportName}`) || trimmed.startsWith(`export let ${exportName}`)) {
			// Also skip continuation lines (.withExtension, etc.)
			skipContinuation = true;
			continue;
		}

		// Skip continuation lines (start with . or tab+.)
		if (skipContinuation) {
			if (trimmed.startsWith('.') || trimmed.startsWith('\t.')) {
				continue;
			}
			skipContinuation = false;
		}

		result.push(line);
	}

	// Clean up double blank lines
	const cleaned = result.join('\n').replace(/\n{3,}/g, '\n\n');
	return cleaned.trimEnd() + '\n';
}

/**
 * Convert a kebab-case or snake_case workspace name to a camelCase export name.
 *
 * @example
 * ```typescript
 * toCamelCase('my-notes');     // 'myNotes'
 * toCamelCase('my_workspace'); // 'myWorkspace'
 * toCamelCase('simple');       // 'simple'
 * ```
 */
export function toCamelCase(name: string): string {
	return name.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
}
