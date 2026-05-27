import { humanize } from './humanize';
import type { Notice } from './types';

export function resolveDisplay(notice: Notice): {
	title: string;
	description: string | undefined;
} {
	const title =
		(notice.title ?? humanize(notice.cause?.name ?? '')) || 'Notice';
	const description = notice.description ?? notice.cause?.message;
	return { title, description };
}
