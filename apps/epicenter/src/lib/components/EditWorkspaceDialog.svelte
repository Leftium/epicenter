<script module lang="ts">
	function createEditWorkspaceDialogState() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let originalName = $state('');
		let name = $state('');
		let workspaceId = $state('');
		let error = $state<string | null>(null);
		let onConfirm = $state<
			((data: { name: string }) => void | Promise<unknown>) | null
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
			},
			get workspaceId() {
				return workspaceId;
			},
			get error() {
				return error;
			},

			open(opts: {
				workspaceId: string;
				currentName: string;
				onConfirm: (data: { name: string }) => void | Promise<unknown>;
			}) {
				onConfirm = opts.onConfirm;
				isPending = false;
				workspaceId = opts.workspaceId;
				originalName = opts.currentName;
				name = opts.currentName;
				error = null;
				isOpen = true;
			},

			close() {
				isOpen = false;
				isPending = false;
				originalName = '';
				name = '';
				workspaceId = '';
				error = null;
				onConfirm = null;
			},

			get canConfirm() {
				return name.trim().length > 0 && name.trim() !== originalName;
			},

			async confirm() {
				if (!onConfirm) return;
				if (!name.trim()) return;

				error = null;
				const result = onConfirm({ name: name.trim() });

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
									: 'Failed to update workspace';
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

	export const editWorkspaceDialog = createEditWorkspaceDialogState();
</script>

<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
</script>

<Dialog.Root bind:open={editWorkspaceDialog.isOpen}>
	<Dialog.Content class="sm:max-w-md">
		<form
			method="POST"
			onsubmit={(e) => {
				e.preventDefault();
				editWorkspaceDialog.confirm();
			}}
			class="flex flex-col gap-4"
		>
			<Dialog.Header>
				<Dialog.Title>Edit Workspace</Dialog.Title>
				<Dialog.Description>
					Update the workspace name. The ID cannot be changed.
				</Dialog.Description>
			</Dialog.Header>

			<div class="grid gap-4">
				<Field.Field>
					<Label for="workspace-name">Workspace Name</Label>
					<Input
						id="workspace-name"
						bind:value={editWorkspaceDialog.name}
						placeholder="My Workspace"
						disabled={editWorkspaceDialog.isPending}
					/>
					{#if editWorkspaceDialog.error}
						<Field.Error>{editWorkspaceDialog.error}</Field.Error>
					{/if}
				</Field.Field>

				<Field.Field>
					<Label for="workspace-id">
						Workspace ID
						<span class="text-muted-foreground ml-2 text-xs font-normal"
							>(read-only)</span
						>
					</Label>
					<Input
						id="workspace-id"
						value={editWorkspaceDialog.workspaceId}
						disabled
						class="font-mono text-sm"
					/>
					<Field.Description>
						The workspace ID cannot be changed after creation.
					</Field.Description>
				</Field.Field>
			</div>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => editWorkspaceDialog.cancel()}
					disabled={editWorkspaceDialog.isPending}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={editWorkspaceDialog.isPending ||
						!editWorkspaceDialog.canConfirm}
				>
					{editWorkspaceDialog.isPending ? 'Saving...' : 'Save'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
