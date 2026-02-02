import type { KebabCaseSlug, SnakeCaseSlug } from './slugify';

export function snakeToKebab(value: SnakeCaseSlug): KebabCaseSlug {
	return value.replace(/_/g, '-') as KebabCaseSlug;
}

export function kebabToSnake(value: KebabCaseSlug): SnakeCaseSlug {
	return value.replace(/-/g, '_') as SnakeCaseSlug;
}

export function snakeToCamel(value: SnakeCaseSlug): string {
	return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function kebabToCamel(value: KebabCaseSlug): string {
	return value.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
