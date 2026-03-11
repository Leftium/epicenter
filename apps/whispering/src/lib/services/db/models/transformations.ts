import { type } from 'arktype';
import { nanoid } from 'nanoid/non-secure';
import {
	TransformationStep,
	TransformationStepV1,
	TransformationStepV2,
} from './transformation-steps.js';

// ============================================================================
// VERSION 1 (FROZEN)
// ============================================================================

/**
 * Transformation type containing V1 steps (before Custom provider fields).
 * Used only for typing old data during Dexie migration in web.ts.
 *
 * Note: The Transformation fields themselves are unchanged; only the step
 * schema differs between "V1" and "V2".
 */
const TransformationV1 = type({
	id: 'string',
	title: 'string',
	description: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	steps: [TransformationStepV1, '[]'],
});

export type TransformationV1 = typeof TransformationV1.infer;

// ============================================================================
// VERSION 2 (CURRENT)
// ============================================================================

/**
 * Current Transformation schema with V2 steps.
 * Extends V1 by using V2 steps.
 *
 * The Transformation container fields (id, title, description, createdAt, updatedAt)
 * have not changed since V1. Only TransformationStep has versioning.
 */
const TransformationV2 = TransformationV1.merge({
	steps: [TransformationStepV2, '[]'],
});

export type TransformationV2 = typeof TransformationV2.infer;

// ============================================================================
// MIGRATING VALIDATOR
// ============================================================================

/**
 * Transformation validator with automatic step migration.
 * Accepts transformations with V1 or V2 steps and migrates all steps to V2.
 * Use this when reading data that might contain old schema versions.
 */
export const Transformation = TransformationV2.merge({
	steps: [TransformationStep, '[]'],
});

export type Transformation = TransformationV2;

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

export function generateDefaultTransformation(): Transformation {
	const now = new Date().toISOString();
	return {
		id: nanoid(),
		title: '',
		description: '',
		steps: [],
		createdAt: now,
		updatedAt: now,
	};
}
