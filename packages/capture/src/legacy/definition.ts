import { defineStore, defineTable, field, plainText } from '@epicenter/app';

/**
 * The Personal store Capture used before its captures became Markdown files.
 *
 * Migration only. Nothing in the running app opens this: it exists so the
 * recovery screen can read an account's old rows once, on request, and write
 * them out as a bundle. It is never written to.
 *
 * - `captures` and `thoughts` each had a Yjs plain-text body. A thought named
 *   its capture and an integer position.
 * - `entries` held rows from the earlier recursive model.
 * - `promotions` recorded request IDs for a handoff that no longer exists. It
 *   held no writing, so the export counts it and carries nothing from it.
 */
export const legacyCaptureDefinition = defineStore({
	id: 'so.epicenter.capture',
	title: 'Capture',
	kv: {},
	tables: {
		captures: defineTable({
			fields: { capturedAt: field.instant() },
			body: plainText(),
		}),
		thoughts: defineTable({
			fields: {
				captureId: field.reference('captures'),
				position: field.integer(),
			},
			body: plainText(),
		}),
		entries: defineTable({
			fields: {
				parentId: field.nullable(field.string()),
				capturedAt: field.instant(),
			},
			body: plainText(),
		}),
		promotions: defineTable({
			fields: {
				requestId: field.string(),
				captureId: field.nullable(field.reference('captures')),
			},
		}),
	},
});
