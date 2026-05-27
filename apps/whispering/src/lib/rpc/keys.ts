import { defineKeys } from 'wellcrafted/query';

export const audioKeys = defineKeys({
	all: ['audio'],
	playbackUrl: (id: string) => ['audio', 'playbackUrl', id] as const,
});

export const autostartKeys = defineKeys({
	all: ['autostart'],
	isEnabled: ['autostart', 'isEnabled'],
	enable: ['autostart', 'enable'],
	disable: ['autostart', 'disable'],
});

export const downloadKeys = defineKeys({
	all: ['download'],
	downloadRecording: ['download', 'downloadRecording'],
});

export const manualRecorderKeys = defineKeys({
	all: ['recorder'],
	devices: ['recorder', 'devices'],
});

export const textKeys = defineKeys({
	all: ['text'],
	readFromClipboard: ['text', 'readFromClipboard'],
});

export const transcriptionKeys = defineKeys({
	all: ['transcription'],
	isTranscribing: ['transcription', 'isTranscribing'],
});

export const transformerKeys = defineKeys({
	all: ['transformer'],
	transformInput: ['transformer', 'transformInput'],
	transformRecording: ['transformer', 'transformRecording'],
});

export const vadKeys = defineKeys({
	all: ['vad'],
	devices: ['vad', 'devices'],
});
