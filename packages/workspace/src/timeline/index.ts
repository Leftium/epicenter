/**
 * Workspace timeline barrel — re-exports from `@epicenter/document`.
 *
 * Timeline primitives now live in the document package so consumers can
 * compose them against any standalone Y.Doc without pulling in the
 * workspace layer. This barrel is a thin pass-through for backwards
 * compatibility with existing imports.
 */

export {
	attachTimeline,
	computeMidpoint,
	type ContentType,
	generateInitialOrders,
	parseSheetFromCsv,
	populateFragmentFromText,
	type RichTextEntry,
	serializeSheetToCsv,
	type SheetBinding,
	type SheetEntry,
	type TextEntry,
	type Timeline,
	type TimelineEntry,
} from '@epicenter/document';
