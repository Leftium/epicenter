import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const ContentConversionError = defineErrors({
	ConversionFailed: ({
		from,
		to,
		reason,
	}: {
		from: string;
		to: string;
		reason: string;
	}) => ({
		message: `Cannot convert ${from} to ${to}: ${reason}`,
		from,
		to,
		reason,
	}),
});
export type ContentConversionError = InferErrors<typeof ContentConversionError>;
