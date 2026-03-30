/**
 * Frontmatter schema for a SKILL.md file.
 *
 * Mirrors the Agent Skills specification structure:
 * - `name` and `description` are required
 * - `metadata` holds optional key-value pairs (author, version, etc.)
 * - `compatibility` describes which agents/tools the skill targets
 * - `license` for redistribution terms
 *
 * @example
 * ```typescript
 * const fm: SkillFrontmatter = {
 *   name: 'svelte',
 *   description: 'Svelte 5 patterns including runes...',
 *   metadata: { author: 'epicenter', version: '2.0' },
 * };
 * ```
 */
export type SkillFrontmatter = {
	name: string;
	description: string;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
};

/**
 * Name validation regex from Agent Skills spec.
 *
 * Rules:
 * - Lowercase alphanumeric + hyphens only
 * - Must start and end with alphanumeric
 * - No consecutive hyphens
 * - 1–64 characters
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate skill frontmatter against the Agent Skills spec.
 *
 * Returns an array of human-readable error strings. Empty array = valid.
 * Runs on save and before export—never blocks editing.
 *
 * @example
 * ```typescript
 * const errors = validateSkill({ name: 'My Skill', description: '' });
 * // ['name must be lowercase alphanumeric...', 'description is required']
 * ```
 */
export function validateSkill(frontmatter: SkillFrontmatter): string[] {
	const errors: string[] = [];

	// name: required, 1–64 chars, lowercase + hyphens, no leading/trailing/consecutive hyphens
	if (!frontmatter.name) {
		errors.push('name is required');
	} else if (frontmatter.name.length > 64) {
		errors.push('name must be ≤64 characters');
	} else if (!SKILL_NAME_PATTERN.test(frontmatter.name)) {
		errors.push(
			'name must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens',
		);
	}
	if (frontmatter.name?.includes('--')) {
		errors.push('name must not contain consecutive hyphens');
	}

	// description: required, 1–1024 chars
	if (!frontmatter.description) {
		errors.push('description is required');
	} else if (frontmatter.description.length > 1024) {
		errors.push('description must be ≤1024 characters');
	}

	// compatibility: optional, ≤500 chars
	if (frontmatter.compatibility && frontmatter.compatibility.length > 500) {
		errors.push('compatibility must be ≤500 characters');
	}

	return errors;
}

/**
 * Default SKILL.md content for new skills.
 *
 * Creates valid frontmatter with placeholder values that pass validation,
 * plus a minimal instruction body with standard sections.
 */
export function createSkillTemplate(name: string): string {
	return `---
name: ${name}
description: TODO—describe when and why to use this skill.
---

# ${name
		.split('-')
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ')}

## When to Apply This Skill

- TODO

## Instructions

TODO
`;
}
