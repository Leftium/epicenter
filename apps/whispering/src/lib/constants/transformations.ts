/**
 * Transformation step type constants. The schema in `workspace/definition.ts`
 * validates against `TRANSFORMATION_STEP_TYPES`, and the transformations editor
 * renders `TRANSFORMATION_STEP_TYPE_OPTIONS`, so this is the single source of
 * truth for both.
 */
export const TRANSFORMATION_STEP_TYPES = [
	'prompt_transform',
	'find_replace',
] as const;

const TRANSFORMATION_STEP_TYPES_TO_LABEL = {
	prompt_transform: 'Prompt Transform',
	find_replace: 'Find Replace',
} as const satisfies Record<(typeof TRANSFORMATION_STEP_TYPES)[number], string>;

export const TRANSFORMATION_STEP_TYPE_OPTIONS = TRANSFORMATION_STEP_TYPES.map(
	(type) => ({
		value: type,
		label: TRANSFORMATION_STEP_TYPES_TO_LABEL[type],
	}),
);
