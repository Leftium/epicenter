import { defineQuery } from '$lib/rpc/client';
import { services } from '$lib/services';

const textKeys = {
	readFromClipboard: ['text', 'readFromClipboard'] as const,
} as const;

export const text = {
	readFromClipboard: defineQuery({
		queryKey: textKeys.readFromClipboard,
		queryFn: () => services.text.readFromClipboard(),
	}),
};
