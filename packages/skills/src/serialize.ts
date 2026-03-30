/**
 * @fileoverview Pure functions to serialize skill data back to SKILL.md format.
 *
 * Reconstructs YAML frontmatter from table columns and appends the instructions
 * markdown body. Only includes non-undefined optional fields in frontmatter to
 * keep exported files clean.
 *
 * @module
 */

import { stringify as stringifyYaml } from 'yaml';
import type { Skill } from './tables.js';

/**
 * Serialize a skill row and its instructions back to SKILL.md format.
 *
 * Reconstructs the agentskills.io SKILL.md file from workspace table data.
 * Required fields (`name`, `description`) are always included. Optional fields
 * (`license`, `compatibility`, `metadata`, `allowedTools`) are only included
 * when they have a defined value—this keeps exported files minimal and clean.
 *
 * The `metadata` column (JSON-stringified `Record<string, string>`) is parsed
 * back into a nested YAML object. The `allowedTools` column is written as
 * `allowed-tools` in frontmatter to match the agentskills.io spec.
 *
 * @param skill - The skill row from the workspace table
 * @param instructions - The instructions text from the skill's document handle
 * @returns A valid SKILL.md file string ready to write to disk
 *
 * @example
 * ```typescript
 * import { serializeSkillMd } from '@epicenter/skills'
 *
 * const skill = ws.tables.skills.find(s => s.name === 'svelte')
 * if (skill) {
 *   const handle = await ws.documents.skills.instructions.open(skill.id)
 *   const md = serializeSkillMd(skill, handle.read())
 *   await writeFile(`${dir}/${skill.name}/SKILL.md`, md)
 * }
 * ```
 */
export function serializeSkillMd(skill: Skill, instructions: string): string {
	const fm = {
		name: skill.name,
		description: skill.description,
		...(skill.license !== undefined && { license: skill.license }),
		...(skill.compatibility !== undefined && { compatibility: skill.compatibility }),
		...(skill.metadata !== undefined && {
			metadata: JSON.parse(skill.metadata) as Record<string, string>,
		}),
		...(skill.allowedTools !== undefined && {
			'allowed-tools': skill.allowedTools,
		}),
	};

	const yamlStr = stringifyYaml(fm, { lineWidth: 0 });
	return `---\n${yamlStr}---\n\n${instructions}`;
}

/**
 * Serialize reference content for writing to disk.
 *
 * Currently a passthrough—the reference markdown is stored as-is. This function
 * exists for symmetry with `serializeSkillMd` and as an extension point for
 * future processing (e.g., link rewriting, frontmatter injection).
 *
 * @param content - The reference markdown content from the document handle
 * @returns The markdown string ready to write to disk
 *
 * @example
 * ```typescript
 * import { serializeReferenceMd } from '@epicenter/skills'
 *
 * const handle = await ws.documents.references.content.open(ref.id)
 * const md = serializeReferenceMd(handle.read())
 * await writeFile(`${dir}/${skill.name}/references/${ref.path}`, md)
 * ```
 */
export function serializeReferenceMd(content: string): string {
	return content;
}
