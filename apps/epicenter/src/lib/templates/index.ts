/**
 * Workspace templates for pre-configured schemas.
 *
 * Templates provide ready-to-use workspace definitions that users can
 * select when creating a new workspace instead of starting from scratch.
 *
 * Each template contains:
 * - Display metadata (id, name, description, icon) for the UI
 * - A workspace definition (for creating workspace clients)
 */

import { ENTRIES_TEMPLATE } from './entries';
import { WHISPERING_TEMPLATE } from './whispering';
import { FUJI_TEMPLATE } from './fuji';
import { HONEYCRISP_TEMPLATE } from './honeycrisp';

/**
 * Registry of available workspace templates.
 *
 * Add new templates by importing them and adding to this array.
 * Types are derived from this array, so adding a template automatically
 * makes its ID available as a valid `WorkspaceTemplateId`.
 */
export const WORKSPACE_TEMPLATES = [
	ENTRIES_TEMPLATE,
	FUJI_TEMPLATE,
	HONEYCRISP_TEMPLATE,
	WHISPERING_TEMPLATE,
] as const;

/**
 * A workspace template with display metadata and a workspace definition.
 */
export type WorkspaceTemplate = (typeof WORKSPACE_TEMPLATES)[number];

/**
 * Valid template IDs derived from the registry.
 *
 * This is a string literal union of all template IDs, providing
 * compile-time safety when referencing templates.
 */
export type WorkspaceTemplateId = WorkspaceTemplate['id'];

/**
 * O(1) lookup map for templates by ID.
 *
 * Use this instead of `.find()` for cleaner, more efficient lookups.
 *
 * @example
 * ```typescript
 * const template = WORKSPACE_TEMPLATE_BY_ID['epicenter.entries'];
 * ```
 */
export const WORKSPACE_TEMPLATE_BY_ID = Object.fromEntries(
	WORKSPACE_TEMPLATES.map((t) => [t.id, t]),
) as Record<WorkspaceTemplateId, WorkspaceTemplate>;
