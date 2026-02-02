<script module lang="ts">
	import { toKebabCase } from '$lib/utils/slug';
	import {
		WORKSPACE_TEMPLATES,
		WORKSPACE_TEMPLATE_BY_ID,
		type WorkspaceTemplate,
		type WorkspaceTemplateId,
	} from '$lib/templates';

	/**
	 * Template selection state for the Select component.
	 * Empty string represents "no template" (blank workspace).
	 * Template IDs are derived from the registry for type safety.
	 */
	type TemplateSelectionId = WorkspaceTemplateId | '';

	export type CreateWorkspaceData = {
		name: string;
		id: string;
		template: WorkspaceTemplate | null;
	};

	function createWorkspaceDialogState() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let selectedTemplateId = $state<TemplateSelectionId>('');
		let name = $state('');
		let id = $state('');
		let isIdManuallyEdited = $state(false);
		let isNameManuallyEdited = $state(false);
		let error = $state<string | null>(null);
		let onConfirm = $state<
			((data: CreateWorkspaceData) => void | Promise<unknown>) | null
		>(null);

		/**
		 * Resolve selected template ID to template object.
		 * Returns null for blank (empty string) selection.
		 */
		function getTemplate(): WorkspaceTemplate | null {
			if (!selectedTemplateId) return null;
			return WORKSPACE_TEMPLATE_BY_ID[selectedTemplateId] ?? null;
		}

		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value) {
				isOpen = value;
			},
			get isPending() {
				return isPending;
			},
			get selectedTemplateId() {
				return selectedTemplateId;
			},
			set selectedTemplateId(value: TemplateSelectionId) {
				selectedTemplateId = value;
				error = null;

				// Auto-fill name and ID from template if not manually edited
				const template = getTemplate();
				if (template) {
					if (!isNameManuallyEdited) {
						name = template.name;
					}
					if (!isIdManuallyEdited) {
						id = template.id;
					}
				} else {
					// Reset to blank
					if (!isNameManuallyEdited) {
						name = '';
					}
					if (!isIdManuallyEdited) {
						id = '';
					}
				}
			},
			get name() {
				return name;
			},
			set name(value) {
				name = value;
				error = null;
				isNameManuallyEdited = true;
				if (!isIdManuallyEdited) {
					id = toKebabCase(value);
				}
			},
			get id() {
				return id;
			},
			set id(value) {
				id = value;
				error = null;
				isIdManuallyEdited = true;
			},
			get isIdManuallyEdited() {
				return isIdManuallyEdited;
			},
			get error() {
				return error;
			},

			open(opts: {
				onConfirm: (data: CreateWorkspaceData) => void | Promise<unknown>;
			}) {
				onConfirm = opts.onConfirm;
				isPending = false;
				selectedTemplateId = '';
				name = '';
				id = '';
				error = null;
				isIdManuallyEdited = false;
				isNameManuallyEdited = false;
				isOpen = true;
			},

			close() {
				isOpen = false;
				isPending = false;
				selectedTemplateId = '';
				name = '';
				id = '';
				error = null;
				isIdManuallyEdited = false;
				isNameManuallyEdited = false;
				onConfirm = null;
			},

			resetId() {
				const template = getTemplate();
				if (template && !isNameManuallyEdited) {
					id = template.id;
				} else {
					id = toKebabCase(name);
				}
				error = null;
				isIdManuallyEdited = false;
			},

			get canConfirm() {
				return name.trim().length > 0 && id.trim().length > 0;
			},

			async confirm() {
				if (!onConfirm) return;
				if (!name.trim() || !id.trim()) return;

				error = null;
				const finalId = toKebabCase(id.trim());
				const template = getTemplate();
				const result = onConfirm({
					name: name.trim(),
					id: finalId,
					template,
				});

				if (result instanceof Promise) {
					isPending = true;
					try {
						await result;
						isOpen = false;
					} catch (e) {
						error =
							e instanceof Error
								? e.message
								: typeof e === 'object' && e !== null && 'message' in e
									? String((e as { message: unknown }).message)
									: 'Failed to create workspace';
					} finally {
						isPending = false;
					}
				} else {
					isOpen = false;
				}
			},

			cancel() {
				isOpen = false;
			},
		};
	}

	export const createWorkspaceDialog = createWorkspaceDialogState();
</script>

<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { Input } from '@epicenter/ui/input';
	import { Button } from '@epicenter/ui/button';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';

	const templateOptions = [
		{
			value: '' as const,
			label: 'Blank',
			description: 'Start with an empty workspace',
		},
		...WORKSPACE_TEMPLATES.map((t) => ({
			value: t.id,
			label: t.name,
			description: `Pre-configured with ${Object.keys(t.tables).length} table(s)`,
		})),
	];

	const selectedTemplateLabel = $derived(
		templateOptions.find(
			(t) => t.value === createWorkspaceDialog.selectedTemplateId,
		)?.label ?? 'Select template',
	);
</script>

<Dialog.Root bind:open={createWorkspaceDialog.isOpen}>
	<Dialog.Content class="sm:max-w-md">
		<form
			method="POST"
			onsubmit={(e) => {
				e.preventDefault();
				createWorkspaceDialog.confirm();
			}}
			class="flex flex-col gap-4"
		>
			<Dialog.Header>
				<Dialog.Title>Create Workspace</Dialog.Title>
				<Dialog.Description>
					Choose a template or start blank. The ID will be auto-generated from
					the name.
				</Dialog.Description>
			</Dialog.Header>

			<Field.Group>
				<Field.Field>
					<Field.Label for="workspace-template">Template</Field.Label>
					<Select.Root
						type="single"
						bind:value={createWorkspaceDialog.selectedTemplateId}
					>
						<Select.Trigger
							id="workspace-template"
							class="w-full"
							disabled={createWorkspaceDialog.isPending}
						>
							<div class="flex items-center gap-2">
								{#if !createWorkspaceDialog.selectedTemplateId}
									<FileTextIcon class="size-4 text-muted-foreground" />
								{:else}
									<LayoutTemplateIcon class="size-4 text-muted-foreground" />
								{/if}
								{selectedTemplateLabel}
							</div>
						</Select.Trigger>
						<Select.Content>
							{#each templateOptions as option (option.value)}
								<Select.Item value={option.value}>
									<div class="flex flex-col">
										<span>{option.label}</span>
										<span class="text-xs text-muted-foreground">
											{option.description}
										</span>
									</div>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<Field.Description>
						Templates provide pre-configured tables and fields.
					</Field.Description>
				</Field.Field>

				<Field.Field>
					<Field.Label for="workspace-name">Workspace Name</Field.Label>
					<Input
						id="workspace-name"
						bind:value={createWorkspaceDialog.name}
						placeholder="My Workspace"
						disabled={createWorkspaceDialog.isPending}
					/>
				</Field.Field>

				<Field.Field data-invalid={!!createWorkspaceDialog.error}>
					<Field.Label for="workspace-id">
						Workspace ID
						{#if !createWorkspaceDialog.isIdManuallyEdited && createWorkspaceDialog.id}
							<span class="text-muted-foreground ml-2 text-xs font-normal">
								(auto-generated)
							</span>
						{/if}
						{#if createWorkspaceDialog.isIdManuallyEdited}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								class="ml-auto h-5 px-1.5 text-xs"
								onclick={() => createWorkspaceDialog.resetId()}
								disabled={createWorkspaceDialog.isPending}
							>
								<RotateCcwIcon class="mr-1 size-3" />
								Reset
							</Button>
						{/if}
					</Field.Label>
					<Input
						id="workspace-id"
						bind:value={createWorkspaceDialog.id}
						placeholder="my-workspace"
						disabled={createWorkspaceDialog.isPending}
						class="font-mono text-sm"
						aria-invalid={!!createWorkspaceDialog.error}
					/>
					{#if createWorkspaceDialog.error}
						<Field.Error>{createWorkspaceDialog.error}</Field.Error>
					{:else}
						<Field.Description>
							Used in URLs and file paths. Cannot be changed later.
						</Field.Description>
					{/if}
				</Field.Field>
			</Field.Group>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => createWorkspaceDialog.cancel()}
					disabled={createWorkspaceDialog.isPending}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={createWorkspaceDialog.isPending ||
						!createWorkspaceDialog.canConfirm}
				>
					Create
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
