/**
 * Recording mode constants and options
 */

import FileUpIcon from '@lucide/svelte/icons/file-up';
import MicIcon from '@lucide/svelte/icons/mic';
import RadioIcon from '@lucide/svelte/icons/radio';
import type { Component } from 'svelte';

export const RECORDING_MODES = [
	'manual',
	'vad',
	'upload',
	// 'live',
	// 'cpal'
] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const RECORDING_MODE_OPTIONS = [
	{ label: 'Manual', value: 'manual', icon: '🎙️', desktopOnly: false },
	{ label: 'Voice Activated', value: 'vad', icon: '🎤', desktopOnly: false },
	{ label: 'Upload File', value: 'upload', icon: '📁', desktopOnly: false },
	// { label: 'Live', value: 'live', icon: '🎬', desktopOnly: false },
	// { label: 'CPAL', value: 'cpal', icon: '🔊', desktopOnly: true },
] as const satisfies {
	label: string;
	value: RecordingMode;
	icon: string;
	desktopOnly: boolean;
}[];

/**
 * Lucide icon per recording mode for prominent surfaces (the homepage mode
 * toggle and recording cards). The emoji `RECORDING_MODE_OPTIONS.icon` is the
 * compact glyph used in the settings dropdown; this is the full-size lucide
 * iconography used everywhere else. Keyed by mode so adding a mode forces a
 * matching icon at compile time.
 */
export const RECORDING_MODE_ICONS = {
	manual: MicIcon,
	vad: RadioIcon,
	upload: FileUpIcon,
} as const satisfies Record<RecordingMode, Component>;
