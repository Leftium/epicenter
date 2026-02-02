import slugify from '@sindresorhus/slugify';
import type { Brand } from 'wellcrafted/brand';

export type SnakeCaseSlug = string & Brand<'SnakeCaseSlug'>;
export type KebabCaseSlug = string & Brand<'KebabCaseSlug'>;

export function toSnakeCase(value: string): SnakeCaseSlug {
	return slugify(value, { separator: '_' }) as SnakeCaseSlug;
}

export function toKebabCase(value: string): KebabCaseSlug {
	return slugify(value) as KebabCaseSlug;
}
