export {
	ACCELERATOR_KEY_CODES,
	ACCELERATOR_MODIFIER_KEYS,
	ACCELERATOR_PUNCTUATION_KEYS,
	ACCELERATOR_SECTIONS,
	type AcceleratorKeyCode,
	type AcceleratorModifier,
} from './accelerator/supported-keys';

export type { KeyboardEventPossibleKey } from './browser/possible-keys';

export {
	KEYBOARD_EVENT_SUPPORTED_KEY_SECTIONS,
	KEYBOARD_EVENT_SUPPORTED_KEYS,
	type KeyboardEventSupportedKey,
} from './browser/supported-keys';
export { CommandOrAlt, CommandOrControl } from './modifiers';
export { OPTION_DEAD_KEYS } from './option-dead-keys';
export { FUNCTION_KEY_PATTERN } from './patterns';
