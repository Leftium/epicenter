/**
 * @fileoverview Pure functions to parse SKILL.md files into table row data.
 *
 * Splits YAML frontmatter from the markdown body. Frontmatter fields map 1:1
 * to `skillsTable` columns. The body becomes the instructions document content,
 * written separately via a document handle.
 *
 * @module
 */

import { parse as parseYaml } from 'yaml';
import type { Reference, Skill } from './tables.js';

/**
 * Split a markdown file with YAML frontmatter into its two parts.
 *
 * Expects the standard `---` delimiters at the start of the file. If no
 * frontmatter is found, returns an empty object and the entire content as body.
 *
 * @param content - Raw file content (YAML frontmatter + markdown body)
 * @returns The parsed frontmatter object and the markdown body text
 *
 * @example
 * ```typescript
 * const { frontmatter, body } = splitFrontmatter(`---
 * name: svelte
 * description: Svelte 5 patterns...
 * ---
 *
 * # Svelte Guidelines
 * ...`)
 *
 * frontmatter.name        // 'svelte'
 * frontmatter.description // 'Svelte 5 patterns...'
 * body                    // '# Svelte Guidelines\n...'
 * ```
 */
function splitFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { frontmatter: {}, body: content };

	const [, yamlStr, body] = match as [string, string, string];
	const parsed: unknown = parseYaml(yamlStr);
	const frontmatter =
		parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};

	return { frontmatter, body: body.trimStart() };
}

/**
 * Parse a SKILL.md file into fields suitable for a skills table row.
 *
 * Splits YAML frontmatter from the markdown body. Frontmatter fields map 1:1
 * to table columns per the agentskills.io spec:
 *
 * - `id` → extracted from `metadata.id` if present (survives serialize/deserialize
 *   round-trips via the agentskills.io metadata field)
 * - `name` → from the directory name (passed as parameter), not from frontmatter
 * - `description` → frontmatter `description` field
 * - `license` → frontmatter `license` field (optional)
 * - `compatibility` → frontmatter `compatibility` field (optional)
 * - `metadata` → frontmatter `metadata` field minus the reserved `id` key,
 *   JSON-stringified (optional)
 * - `allowedTools` → frontmatter `allowed-tools` field (optional)
 *
 * When `metadata.id` is present in frontmatter, it is extracted as the skill's
 * stable identity and stripped from the `metadata` column to avoid redundancy.
 * This lets IDs survive a full export→import cycle even on a fresh workspace.
 *
 * @param name - The skill's directory name (becomes the `name` column)
 * @param content - The raw SKILL.md file content
 * @returns Parsed skill metadata (with `id` from metadata or undefined) and instructions text
 *
 * @example
 * ```typescript
 * import { parseSkillMd } from '@epicenter/skills'
 * import { generateId } from '@epicenter/workspace'
 *
 * const raw = await readFile('.agents/skills/svelte/SKILL.md', 'utf-8')
 * const { skill, instructions } = parseSkillMd('svelte', raw)
 *
 * // Use parsed id if available, otherwise generate a new one
 * const fullSkill = { ...skill, id: skill.id ?? generateId() }
 * ws.tables.skills.set(fullSkill)
 *
 * const handle = await ws.documents.skills.instructions.open(fullSkill.id)
 * handle.write(instructions)
 * ```
 */
export function parseSkillMd(
	name: string,
	content: string,
): { skill: Omit<Skill, 'id'> & { id: string | undefined }; instructions: string } {
	const { frontmatter, body } = splitFrontmatter(content);

	// Extract id from metadata.id, then strip it so it doesn't pollute the metadata column
	let parsedId: string | undefined;
	let metadataRecord: Record<string, unknown> | undefined;

	if (
		frontmatter.metadata != null &&
		typeof frontmatter.metadata === 'object' &&
		!Array.isArray(frontmatter.metadata)
	) {
		const { id: rawId, ...rest } = frontmatter.metadata as Record<
			string,
			unknown
		>;
		if (typeof rawId === 'string') parsedId = rawId;
		// Only keep metadata if there are remaining keys after stripping id
		if (Object.keys(rest).length > 0) metadataRecord = rest;
	}

	return {
		skill: {
			id: parsedId,
			name,
			description: String(frontmatter.description ?? ''),
			license:
				typeof frontmatter.license === 'string'
					? frontmatter.license
					: undefined,
			compatibility:
				typeof frontmatter.compatibility === 'string'
					? frontmatter.compatibility
					: undefined,
			metadata:
				metadataRecord !== undefined
					? JSON.stringify(metadataRecord)
					: undefined,
			allowedTools:
				typeof frontmatter['allowed-tools'] === 'string'
					? frontmatter['allowed-tools']
					: undefined,
			updatedAt: Date.now(),
			_v: 1 as const,
		},
		instructions: body,
	};
}

/**
 * Parse a reference markdown file into fields suitable for a references table row.
 *
 * References are additional documentation files in a skill's `references/`
 * directory. Each file becomes a row in `referencesTable` with the markdown
 * content stored in a per-row Y.Doc via `.withDocument('content')`.
 *
 * Like `parseSkillMd`, the returned object omits `id`—the caller provides one.
 *
 * @param skillId - The parent skill's stable nanoid (FK)
 * @param path - Filename relative to `references/` (e.g., `"component-patterns.md"`)
 * @param content - The raw markdown file content
 * @returns Parsed reference metadata (without `id`) and content text
 *
 * @example
 * ```typescript
 * import { parseReferenceMd } from '@epicenter/skills'
 * import { generateId } from '@epicenter/workspace'
 *
 * const raw = await readFile(
 *   '.agents/skills/svelte/references/component-patterns.md', 'utf-8'
 * )
 * const { reference, content } = parseReferenceMd(
 *   skill.id, 'component-patterns.md', raw
 * )
 *
 * const fullRef = { ...reference, id: generateId() }
 * ws.tables.references.set(fullRef)
 *
 * const handle = await ws.documents.references.content.open(fullRef.id)
 * handle.write(content)
 * ```
 */
export function parseReferenceMd(
	skillId: string,
	path: string,
	content: string,
): {
	reference: Omit<Reference, 'id'> & { id?: undefined };
	content: string;
} {
	return {
		reference: {
			id: undefined,
			skillId,
			path,
			updatedAt: Date.now(),
			_v: 1 as const,
		},
		content,
	};
}
