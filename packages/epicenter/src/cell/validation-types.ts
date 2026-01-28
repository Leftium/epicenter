/**
 * Cell-level validation result types.
 *
 * These parallel core's row-level result types but operate at the cell level,
 * which is the natural granularity for cell workspace validation.
 *
 * @packageDocumentation
 */

// Re-export row-level types from core for convenience
export type {
	GetResult,
	InvalidRowResult,
	NotFoundResult,
	RowResult,
	ValidationError,
	ValidRowResult,
} from '../core/tables/table-helper';

/**
 * A cell that passed validation.
 */
export type ValidCellResult<TValue> = {
	status: 'valid';
	value: TValue;
};

/**
 * A cell that exists but failed validation.
 */
export type InvalidCellResult = {
	status: 'invalid';
	key: string;
	errors: import('../core/tables/table-helper').ValidationError[];
	value: unknown;
};

/**
 * A cell that was not found.
 */
export type NotFoundCellResult = {
	status: 'not_found';
	key: string;
};

/**
 * Result of validating a cell.
 * The shape after parsing a cell from storage - either valid or invalid.
 */
export type CellResult<TValue> = ValidCellResult<TValue> | InvalidCellResult;

/**
 * Result of getting a single cell.
 * Includes not_found since the cell may not exist.
 */
export type GetCellResult<TValue> = CellResult<TValue> | NotFoundCellResult;
