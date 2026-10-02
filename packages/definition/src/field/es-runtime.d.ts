/**
 * The one runtime global this package touches, declared rather than imported.
 *
 * `field.string({ maxBytes })` counts UTF-8 bytes with `TextEncoder`. It exists
 * in every runtime this package targets, but its type lives in `lib.dom` and
 * `@types/node`. Taking either would leak an unrelated runtime surface into the
 * declarations this package publishes.
 */
declare class TextEncoder {
	encode(input?: string): Uint8Array;
}
