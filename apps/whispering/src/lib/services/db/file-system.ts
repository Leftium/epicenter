import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import {
	exists,
	mkdir,
	readDir,
	readTextFile,
	remove,
	rename as tauriRename,
	writeFile as tauriWriteFile,
	writeTextFile,
} from '@tauri-apps/plugin-fs';
import { type } from 'arktype';
import mime from 'mime';
import { nanoid } from 'nanoid/non-secure';
import { tryAsync } from 'wellcrafted/result';
import { PATHS } from '$lib/constants/paths';
import { FsServiceLive } from '$lib/services/desktop/fs';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter';
import { Transformation, TransformationRun } from './models';
import type { DbService } from './types';
import { DbError } from './types';

/**
 * Reads all markdown files from a directory using the Rust command.
 * This is a single FFI call that reads all .md files natively in Rust,
 * avoiding thousands of individual async calls for path joining and file reading.
 *
 * @param directoryPath - Absolute path to the directory containing .md files
 * @returns Array of markdown file contents as strings
 */
async function readMarkdownFiles(directoryPath: string): Promise<string[]> {
	return invoke('read_markdown_files', { directoryPath });
}

/**
 * Deletes files inside a directory by filename.
 * Validates that filenames are single path components (no traversal).
 *
 * @param directory - Absolute path to the directory containing the files
 * @param filenames - Array of leaf filenames to delete
 * @returns Number of files successfully deleted
 */
async function deleteFilesInDirectory(
	directory: string,
	filenames: string[],
): Promise<number> {
	return invoke('delete_files_in_directory', { directory, filenames });
}

/**
 * File system-based database implementation for desktop.
 * Stores data as markdown files with YAML front matter.
 *
 * Directory structure:
 * - recordings/
 *   - {id}.{ext} (audio file: .wav, .opus, .mp3, etc.)
 *   - {id}.md (metadata materialized by workspace, NOT written by this service)
 * - transformations/
 *   - {id}.md (transformation configuration)
 * - transformation-runs/
 *   - {id}.md (execution history)
 */
export function createFileSystemDbService(): DbService {
	return {
		audio: {
			async save(recordingId, audio) {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						await mkdir(recordingsPath, { recursive: true });

						const extension = mime.getExtension(audio.type) ?? 'bin';
						const audioPath = await PATHS.DB.RECORDING_AUDIO(
							recordingId,
							extension,
						);
						const arrayBuffer = await audio.arrayBuffer();
						await tauriWriteFile(audioPath, new Uint8Array(arrayBuffer));
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async delete(idOrIds) {
				const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const idsToDelete = new Set(ids);
						const allFiles = await readDir(recordingsPath);
						const filenames = allFiles
							.filter((file) => {
								const id = file.name.split('.')[0] ?? '';
								return idsToDelete.has(id);
							})
							.map((file) => file.name);
						await deleteFilesInDirectory(recordingsPath, filenames);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},


			async getBlob(recordingId: string) {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const audioFilename = await findAudioFile(
							recordingsPath,
							recordingId,
						);

						if (!audioFilename) {
							throw new Error(
								`Audio file not found for recording ${recordingId}`,
							);
						}

						const audioPath = await PATHS.DB.RECORDING_FILE(audioFilename);

						// Use existing fsService.pathToBlob utility
						const { data: blob, error } =
							await FsServiceLive.pathToBlob(audioPath);
						if (error) throw error;

						return blob;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async ensurePlaybackUrl(recordingId: string) {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const audioFilename = await findAudioFile(
							recordingsPath,
							recordingId,
						);

						if (!audioFilename) {
							throw new Error(
								`Audio file not found for recording ${recordingId}`,
							);
						}

						const audioPath = await PATHS.DB.RECORDING_FILE(audioFilename);
						const assetUrl = convertFileSrc(audioPath);

						// Return the URL as-is from convertFileSrc()
						// The Tauri backend handles URL decoding automatically
						return assetUrl;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			revokeUrl(_recordingId: string) {
				// No-op on desktop, URLs are asset:// protocol managed by Tauri
			},

			async clear() {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const dirExists = await exists(recordingsPath);
						if (!dirExists) return undefined;

						const files = await readDir(recordingsPath);
						const filenames = files.map((file) => file.name);
						await deleteFilesInDirectory(recordingsPath, filenames);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},
		},

		transformations: {
			async getAll() {
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();

						// Ensure directory exists
						const dirExists = await exists(transformationsPath);
						if (!dirExists) {
							await mkdir(transformationsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(transformationsPath);

						// Parse all files
						const transformations = contents.map((content) => {
							const { data } = parseFrontmatter(content);

							// Validate with migrating schema (accepts V1 or V2, outputs V2)
							const validated = Transformation(data);
							if (validated instanceof type.errors) {
								console.error(`Invalid transformation:`, validated.summary);
								return null; // Skip invalid transformation
							}

							return validated;
						});

						return transformations.filter(
							(t): t is Transformation => t !== null,
						);
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async getById(id: string) {
				return tryAsync({
					try: async () => {
						const mdPath = await PATHS.DB.TRANSFORMATION_MD(id);

						const fileExists = await exists(mdPath);
						if (!fileExists) return null;

						const content = await readTextFile(mdPath);
						const { data } = parseFrontmatter(content);

						// Validate with migrating schema (accepts V1 or V2, outputs V2)
						const validated = Transformation(data);
						if (validated instanceof type.errors) {
							throw new Error(`Invalid transformation: ${validated.summary}`);
						}

						return validated;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async create(transformationOrTransformations) {
				const transformations = Array.isArray(transformationOrTransformations)
					? transformationOrTransformations
					: [transformationOrTransformations];
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
						await mkdir(transformationsPath, { recursive: true });
						await Promise.all(
							transformations.map(async (transformation) => {
								const mdContent = stringifyFrontmatter('', transformation);
								const mdPath = await PATHS.DB.TRANSFORMATION_MD(
									transformation.id,
								);
								const tmpPath = `${mdPath}.tmp`;
								await writeTextFile(tmpPath, mdContent);
								await tauriRename(tmpPath, mdPath);
							}),
						);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async update(transformation: Transformation) {
				const now = new Date().toISOString();
				const transformationWithTimestamp = {
					...transformation,
					updatedAt: now,
				} satisfies Transformation;

				return tryAsync({
					try: async () => {
						const mdPath = await PATHS.DB.TRANSFORMATION_MD(transformation.id);

						// Create .md file with front matter
						const mdContent = stringifyFrontmatter(
							'',
							transformationWithTimestamp,
						);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await tauriRename(tmpPath, mdPath);

						return transformationWithTimestamp;
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async delete(transformationOrTransformations) {
				const transformations = Array.isArray(transformationOrTransformations)
					? transformationOrTransformations
					: [transformationOrTransformations];
				return tryAsync({
					try: async () => {
						const transformationsDir = await PATHS.DB.TRANSFORMATIONS();
						const filenames = transformations.map((t) => `${t.id}.md`);
						await deleteFilesInDirectory(transformationsDir, filenames);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async clear() {
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
						const dirExists = await exists(transformationsPath);
						if (dirExists) {
							await remove(transformationsPath, { recursive: true });
							await mkdir(transformationsPath, { recursive: true });
						}
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async getCount() {
				return tryAsync({
					try: async () => {
						const { data: transformations, error } = await this.getAll();
						if (error) throw error;
						return transformations.length;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},
		},

		runs: {
			async getAll() {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						// Ensure directory exists
						const dirExists = await exists(runsPath);
						if (!dirExists) {
							await mkdir(runsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(runsPath);

						// Parse all files
						const runs = contents.map((content) => {
							const { data } = parseFrontmatter(content);

							// Validate with arktype schema
							const validated = TransformationRun(data);
							if (validated instanceof type.errors) {
								console.error(`Invalid transformation run:`, validated.summary);
								return null; // Skip invalid run
							}

							return validated;
						});

						// Filter out any invalid entries
						return runs.filter((run) => run !== null);
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async getById(id: string) {
				return tryAsync({
					try: async () => {
						const mdPath = await PATHS.DB.TRANSFORMATION_RUN_MD(id);

						const fileExists = await exists(mdPath);
						if (!fileExists) return null;

						const content = await readTextFile(mdPath);
						const { data } = parseFrontmatter(content);

						// Validate with arktype schema
						const validated = TransformationRun(data);
						if (validated instanceof type.errors) {
							throw new Error(
								`Invalid transformation run: ${validated.summary}`,
							);
						}

						return validated;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async getByTransformationId(transformationId: string) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						// Ensure directory exists
						const dirExists = await exists(runsPath);
						if (!dirExists) {
							await mkdir(runsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(runsPath);

						// Parse and filter
						const runs = contents
							.map((content) => {
								const { data } = parseFrontmatter(content);

								// Validate with arktype schema
								const validated = TransformationRun(data);
								if (validated instanceof type.errors) {
									console.error(
										`Invalid transformation run:`,
										validated.summary,
									);
									return null; // Skip invalid run
								}

								return validated;
							})
							.filter((run) => run !== null)
							.filter((run) => run.transformationId === transformationId)
							.sort(
								(a, b) =>
									new Date(b.startedAt).getTime() -
									new Date(a.startedAt).getTime(),
							);

						return runs;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async getByRecordingId(recordingId: string) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						// Ensure directory exists
						const dirExists = await exists(runsPath);
						if (!dirExists) {
							await mkdir(runsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(runsPath);

						// Parse and filter
						const runs = contents
							.map((content) => {
								const { data } = parseFrontmatter(content);

								// Validate with arktype schema
								const validated = TransformationRun(data);
								if (validated instanceof type.errors) {
									console.error(
										`Invalid transformation run:`,
										validated.summary,
									);
									return null; // Skip invalid run
								}

								return validated;
							})
							.filter((run) => run !== null)
							.filter((run) => run.recordingId === recordingId)
							.sort(
								(a, b) =>
									new Date(b.startedAt).getTime() -
									new Date(a.startedAt).getTime(),
							);

						return runs;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},

			async create(runOrRuns) {
				const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();
						await mkdir(runsPath, { recursive: true });

						await Promise.all(
							runs.map(async (run) => {
								const mdContent = stringifyFrontmatter('', run);
								const mdPath = await PATHS.DB.TRANSFORMATION_RUN_MD(run.id);
								const tmpPath = `${mdPath}.tmp`;
								await writeTextFile(tmpPath, mdContent);
								await tauriRename(tmpPath, mdPath);
							}),
						);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async addStep(run, step) {
				return tryAsync({
					try: async () => {
						const now = new Date().toISOString();
						const newTransformationStepRun = {
							id: nanoid(),
							stepId: step.id,
							input: step.input,
							startedAt: now,
							completedAt: null,
							status: 'running',
						} as const;

						const updatedRun: TransformationRun = {
							...run,
							stepRuns: [...run.stepRuns, newTransformationStepRun],
						};

						// Update .md file
						const mdContent = stringifyFrontmatter('', updatedRun);
						const mdPath = await PATHS.DB.TRANSFORMATION_RUN_MD(run.id);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await tauriRename(tmpPath, mdPath);

						return newTransformationStepRun;
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async failStep(run, stepRunId, error) {
				return tryAsync({
					try: async () => {
						const now = new Date().toISOString();

						const failedRun = {
							...run,
							status: 'failed' as const,
							completedAt: now,
							error,
							stepRuns: run.stepRuns.map((stepRun) => {
								if (stepRun.id === stepRunId) {
									return {
										...stepRun,
										status: 'failed' as const,
										completedAt: now,
										error,
									};
								}
								return stepRun;
							}),
						};

						// Update .md file
						const mdContent = stringifyFrontmatter('', failedRun);
						const mdPath = await PATHS.DB.TRANSFORMATION_RUN_MD(run.id);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await tauriRename(tmpPath, mdPath);

						return failedRun;
					},
					catch: (e) => DbError.MutationFailed({ cause: e }),
				});
			},

			async completeStep(run, stepRunId, output) {
				return tryAsync({
					try: async () => {
						const now = new Date().toISOString();

						const updatedRun: TransformationRun = {
							...run,
							stepRuns: run.stepRuns.map((stepRun) => {
								if (stepRun.id === stepRunId) {
									return {
										...stepRun,
										status: 'completed',
										completedAt: now,
										output,
									};
								}
								return stepRun;
							}),
						};

						// Update .md file
						const mdContent = stringifyFrontmatter('', updatedRun);
						const mdPath = await PATHS.DB.TRANSFORMATION_RUN_MD(run.id);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await tauriRename(tmpPath, mdPath);

						return updatedRun;
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async complete(run, output) {
				return tryAsync({
					try: async () => {
						const now = new Date().toISOString();

						const completedRun = {
							...run,
							status: 'completed' as const,
							completedAt: now,
							output,
						};

						// Update .md file
						const mdContent = stringifyFrontmatter('', completedRun);
						const mdPath = await PATHS.DB.TRANSFORMATION_RUN_MD(run.id);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await tauriRename(tmpPath, mdPath);

						return completedRun;
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async delete(runOrRuns) {
				const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
				return tryAsync({
					try: async () => {
						const runsDir = await PATHS.DB.TRANSFORMATION_RUNS();
						const filenames = runs.map((run) => `${run.id}.md`);
						await deleteFilesInDirectory(runsDir, filenames);
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async clear() {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();
						const dirExists = await exists(runsPath);
						if (dirExists) {
							await remove(runsPath, { recursive: true });
							await mkdir(runsPath, { recursive: true });
						}
					},
					catch: (error) => DbError.MutationFailed({ cause: error }),
				});
			},

			async getCount() {
				return tryAsync({
					try: async () => {
						const { data: runs, error } = await this.getAll();
						if (error) throw error;
						return runs.length;
					},
					catch: (error) => DbError.QueryFailed({ cause: error }),
				});
			},
		},
	};
}

/**
 * Helper function to find audio file by ID.
 * Reads directory once and finds the matching file by ID prefix.
 * This is much faster than checking every possible extension.
 */
async function findAudioFile(dir: string, id: string): Promise<string | null> {
	const files = await readDir(dir);
	const audioFile = files.find(
		(f) => f.name.startsWith(`${id}.`) && !f.name.endsWith('.md'),
	);
	return audioFile?.name ?? null;
}
