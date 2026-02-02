import { defineMutation, defineQuery } from '$lib/query/client';
import { services } from '$lib/services';

const textKeys = {
	clipboard: ['text', 'clipboard'] as const,
	readFromClipboard: ['text', 'readFromClipboard'] as const,
	copyToClipboard: ['text', 'copyToClipboard'] as const,
	writeToCursor: ['text', 'writeToCursor'] as const,
	simulateEnterKeystroke: ['text', 'simulateEnterKeystroke'] as const,
} as const;

export const text = {
	readFromClipboard: defineQuery({
		queryKey: textKeys.readFromClipboard,
		queryFn: () => services.text.readFromClipboard(),
	}),
	copyToClipboard: defineMutation({
		mutationKey: ['text', 'copyToClipboard'],
		mutationFn: ({ text }: { text: string }) =>
			services.text.copyToClipboard(text),
	}),
	writeToCursor: defineMutation({
		mutationKey: ['text', 'writeToCursor'],
		mutationFn: async ({ text }: { text: string }) => {
			// writeToCursor handles everything internally:
			// 1. Saves current clipboard
			// 2. Writes text to clipboard
			// 3. Simulates paste
			// 4. Restores original clipboard
			return await services.text.writeToCursor(text);
		},
	}),
	simulateEnterKeystroke: defineMutation({
		mutationKey: textKeys.simulateEnterKeystroke,
		mutationFn: () => services.text.simulateEnterKeystroke(),
	}),
};
