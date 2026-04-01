/**
 * Line-based manipulation of `epicenter.config.ts`.
 *
 * Adds or removes import+export lines for workspace factories.
 * Uses simple string manipulation—AST parsing is overkill for
 * inserting import/export pairs.
 *
 * Strategy:
 * - **Add**: Find last import line, insert new import after it.
 *   Append new export at end of file.
 * - **Remove**: Find and remove lines matching the import path
 *   and export name.
 */

/**
 * Add a workspace import and export to an `epicenter.config.ts` file.
 *
 * Inserts the import after the last existing import line (or at the top
 * if no imports exist), and appends the export at the end of the file.
 *
 * @param content - Current file content.
 * @param importPath - Relative import path (e.g., `'./workspaces/my-notes/workspace'`).
 * @param factoryName - Factory function name (e.g., `createMyNotes`).
 * @param exportName - Export variable name (e.g., `myNotes`).
 * @returns Updated file content with the new import and export added.
 *
 * @example
 * ```typescript
 * const updated = addWorkspaceToConfig(
 *   existingContent,
 *   './workspaces/my-notes/workspace',
 *   'createMyNotes',
 *   'myNotes',
 * );
 * ```
 */
export function addWorkspaceToConfig(
	content: string,
	importPath: string,
	factoryName: string,
	exportName: string,
): string {
	const importLine = `import { ${factoryName} } from '${importPath}';`;
	const exportLine = `export const ${exportName} = ${factoryName}()\n\t.withExtension('persistence', setupPersistence);`;

	const lines = content.split('\n');

	// Find the last import line index
	let lastImportIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trimStart().startsWith('import ')) {
			lastImportIndex = i;
		}
	}

	// Insert import after last import (or at top if none)
	if (lastImportIndex >= 0) {
		lines.splice(lastImportIndex + 1, 0, importLine);
	} else {
		// No existing imports — put at top (after any leading comments)
		let insertAt = 0;
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i]!.trim();
			if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '') {
				insertAt = i + 1;
			} else {
				break;
			}
		}
		lines.splice(insertAt, 0, importLine);
	}

	// Append export at end of file
	const joined = lines.join('\n').trimEnd();
	return joined + '\n\n' + exportLine + '\n';
}

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

/**
 * Convert a kebab-case name to a PascalCase factory function name.
 *
 * @example
 * ```typescript
 * toFactoryName('my-notes'); // 'createMyNotes'
 * toFactoryName('simple');   // 'createSimple'
 * ```
 */
export function toFactoryName(name: string): string {
	const pascal = name.replace(/(^|[-_])(\w)/g, (_, __, c: string) =>
		c.toUpperCase(),
	);
	return `create${pascal}`;
}
