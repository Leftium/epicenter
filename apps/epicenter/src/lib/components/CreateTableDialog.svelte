<script module lang="ts">
	import { toSnakeCase } from '$lib/utils/slug';

	export type CreateTableDialogOptions = {
		onConfirm: (data: {
			name: string;
			id: string;
			icon: string | null;
			description: string;
		}) => void | Promise<unknown>;
	};

	function createTableDialogState() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let name = $state('');
		let id = $state('');
		let icon = $state<string | null>(null);
		let description = $state('');
		let isIdManuallyEdited = $state(false);
		let error = $state<string | null>(null);
		let onConfirmCallback = $state<
			CreateTableDialogOptions['onConfirm'] | null
		>(null);

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
			get name() {
				return name;
			},
			set name(value) {
				name = value;
				error = null;
				if (!isIdManuallyEdited) {
					id = toSnakeCase(value);
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
			get icon() {
				return icon;
			},
			set icon(value) {
				icon = value;
			},
			get description() {
				return description;
			},
			set description(value) {
				description = value;
			},
			get isIdManuallyEdited() {
				return isIdManuallyEdited;
			},
			get error() {
				return error;
			},

			open(opts: CreateTableDialogOptions) {
				onConfirmCallback = opts.onConfirm;
				isPending = false;
				name = '';
				id = '';
				icon = null;
				description = '';
				error = null;
				isIdManuallyEdited = false;
				isOpen = true;
			},

			close() {
				isOpen = false;
				isPending = false;
				name = '';
				id = '';
				icon = null;
				description = '';
				error = null;
				isIdManuallyEdited = false;
				onConfirmCallback = null;
			},

			resetId() {
				id = toSnakeCase(name);
				error = null;
				isIdManuallyEdited = false;
			},

			get canConfirm() {
				return name.trim().length > 0 && id.trim().length > 0;
			},

			async confirm() {
				if (!onConfirmCallback) return;
				if (!name.trim() || !id.trim()) return;

				error = null;
				const finalId = toSnakeCase(id.trim());
				const result = onConfirmCallback({
					name: name.trim(),
					id: finalId,
					icon,
					description: description.trim(),
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
									: 'An error occurred';
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

	export const createTableDialog = createTableDialogState();
</script>

<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import * as Popover from '@epicenter/ui/popover';
	import * as EmojiPicker from '@epicenter/ui/emoji-picker';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SmileIcon from '@lucide/svelte/icons/smile';

	let isEmojiPickerOpen = $state(false);
</script>

<Dialog.Root bind:open={createTableDialog.isOpen}>
	<Dialog.Content class="sm:max-w-md">
		<form
			method="POST"
			onsubmit={(e) => {
				e.preventDefault();
				createTableDialog.confirm();
			}}
			class="flex flex-col gap-4"
		>
			<Dialog.Header>
				<Dialog.Title>Add Table</Dialog.Title>
				<Dialog.Description>
					Enter a name for the new table. The ID will be auto-generated from the
					name.
				</Dialog.Description>
			</Dialog.Header>

			<div class="grid gap-4">
				<Field.Field>
					<Label>Icon</Label>
					<div class="flex items-center gap-2">
						<Popover.Root bind:open={isEmojiPickerOpen}>
							<Popover.Trigger>
								<Button
									type="button"
									variant="outline"
									size="icon"
									class="size-10 text-lg"
									disabled={createTableDialog.isPending}
								>
									{#if createTableDialog.icon}
										{createTableDialog.icon}
									{:else}
										<SmileIcon class="size-5 text-muted-foreground" />
									{/if}
								</Button>
							</Popover.Trigger>
							<Popover.Content class="w-auto p-2" align="start">
								<EmojiPicker.Root
									onSelect={(emoji) => {
										createTableDialog.icon = emoji.emoji;
										isEmojiPickerOpen = false;
									}}
								>
									<EmojiPicker.Search placeholder="Search emoji..." />
									<EmojiPicker.Viewport>
										<EmojiPicker.List />
									</EmojiPicker.Viewport>
								</EmojiPicker.Root>
							</Popover.Content>
						</Popover.Root>
						{#if createTableDialog.icon}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								class="h-6 px-2 text-xs"
								onclick={() => (createTableDialog.icon = null)}
								disabled={createTableDialog.isPending}
							>
								Clear
							</Button>
						{/if}
					</div>
					<Field.Description
						>Optional emoji icon for the table.</Field.Description
					>
				</Field.Field>

				<Field.Field>
					<Label for="table-name">Table Name</Label>
					<Input
						id="table-name"
						bind:value={createTableDialog.name}
						placeholder="e.g., Blog Posts, Users, Comments"
						disabled={createTableDialog.isPending}
					/>
				</Field.Field>

				<Field.Field>
					<div class="flex items-center justify-between">
						<Label for="table-id">
							Table ID
							{#if !createTableDialog.isIdManuallyEdited && createTableDialog.id}
								<span class="text-muted-foreground ml-2 text-xs font-normal">
									(auto-generated)
								</span>
							{/if}
						</Label>
						{#if createTableDialog.isIdManuallyEdited}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								class="h-6 px-2 text-xs"
								onclick={() => createTableDialog.resetId()}
								disabled={createTableDialog.isPending}
							>
								<RotateCcwIcon class="mr-1 size-3" />
								Reset
							</Button>
						{/if}
					</div>
					<Input
						id="table-id"
						bind:value={createTableDialog.id}
						placeholder="blog_posts"
						disabled={createTableDialog.isPending}
						class="font-mono text-sm"
						aria-invalid={!!createTableDialog.error}
					/>
					{#if createTableDialog.error}
						<Field.Error>{createTableDialog.error}</Field.Error>
					{:else}
						<Field.Description>Used in code and URLs.</Field.Description>
					{/if}
				</Field.Field>

				<Field.Field>
					<Label for="table-description">Description</Label>
					<Textarea
						id="table-description"
						bind:value={createTableDialog.description}
						placeholder="Optional description of the table..."
						disabled={createTableDialog.isPending}
						rows={2}
					/>
					<Field.Description
						>Optional description for the table.</Field.Description
					>
				</Field.Field>
			</div>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => createTableDialog.cancel()}
					disabled={createTableDialog.isPending}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={createTableDialog.isPending ||
						!createTableDialog.canConfirm}
				>
					Create
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
