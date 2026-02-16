/**
 * Compute the midpoint between two fractional order values with jitter.
 *
 * Adds a small random offset to the midpoint to prevent collisions when
 * multiple users reorder items to the same position simultaneously.
 *
 * @param start - The lower fractional order value
 * @param end - The upper fractional order value
 * @returns The midpoint with jitter applied
 *
 * @example
 * ```typescript
 * computeMidpoint(0, 1);      // ~0.5 with tiny jitter
 * computeMidpoint(0.25, 0.75); // ~0.5 with tiny jitter
 * ```
 */
export function computeMidpoint(start: number, end: number): number {
	const mid = (start + end) / 2;
	const range = (end - start) * 1e-10;
	const jitter = -range / 2 + Math.random() * range;
	return mid + jitter;
}

/**
 * Generate evenly-spaced fractional order values for initial item placement.
 *
 * Returns an array of count values distributed evenly between 0 and 1 (exclusive).
 * Useful for initializing order values when creating new items in a list.
 *
 * @param count - The number of order values to generate
 * @returns Array of evenly-spaced fractional values
 *
 * @example
 * ```typescript
 * generateInitialOrders(3);  // [0.25, 0.5, 0.75]
 * generateInitialOrders(0);  // []
 * generateInitialOrders(1);  // [0.5]
 * ```
 */
export function generateInitialOrders(count: number): number[] {
	const orders: number[] = [];
	for (let i = 0; i < count; i++) {
		orders.push((i + 1) / (count + 1));
	}
	return orders;
}
