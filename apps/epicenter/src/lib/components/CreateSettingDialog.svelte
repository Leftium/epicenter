<script module lang="ts">
	import { toSnakeCase } from '$lib/utils/slug';

	export type CreateSettingDialogOptions = {
		onConfirm: (data: { name: string; key: string }) => void | Promise<unknown>;
	};

	function createSettingDialogState() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let name = $state('');
		let key = $state('');
		let isKeyManuallyEdited = $state(false);
		let error = $state<string | null>(null);
		let onConfirmCallback = $state<
			CreateSettingDialogOptions['onConfirm'] | null
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
				if (!isKeyManuallyEdited) {
					key = toSnakeCase(value);
				}
			},
			get key() {
				return key;
			},
			set key(value) {
				key = value;
				error = null;
				isKeyManuallyEdited = true;
			},
			get isKeyManuallyEdited() {
				return isKeyManuallyEdited;
			},
			get error() {
				return error;
			},

			open(opts: CreateSettingDialogOptions) {
				onConfirmCallback = opts.onConfirm;
				isPending = false;
				name = '';
				key = '';
				error = null;
				isKeyManuallyEdited = false;
				isOpen = true;
			},

			close() {
				isOpen = false;
				isPending = false;
				name = '';
				key = '';
				error = null;
				isKeyManuallyEdited = false;
				onConfirmCallback = null;
			},

			resetKey() {
				key = toSnakeCase(name);
				error = null;
				isKeyManuallyEdited = false;
			},

			get canConfirm() {
				return name.trim().length > 0 && key.trim().length > 0;
			},

			async confirm() {
				if (!onConfirmCallback) return;
				if (!name.trim() || !key.trim()) return;

				error = null;
				const finalKey = toSnakeCase(key.trim());
				const result = onConfirmCallback({
					name: name.trim(),
					key: finalKey,
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

	export const createSettingDialog = createSettingDialogState();
</script>

<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
</script>

<Dialog.Root bind:open={createSettingDialog.isOpen}>
	<Dialog.Content class="sm:max-w-md">
		<form
			method="POST"
			onsubmit={(e) => {
				e.preventDefault();
				createSettingDialog.confirm();
			}}
			class="flex flex-col gap-4"
		>
			<Dialog.Header>
				<Dialog.Title>Add Setting</Dialog.Title>
				<Dialog.Description>
					Enter a name for the new setting. The key will be auto-generated from
					the name.
				</Dialog.Description>
			</Dialog.Header>

			<div class="grid gap-4">
				<Field.Field>
					<Label for="setting-name">Setting Name</Label>
					<Input
						id="setting-name"
						bind:value={createSettingDialog.name}
						placeholder="e.g., API URL, Theme, Feature Flags"
						disabled={createSettingDialog.isPending}
					/>
				</Field.Field>

				<Field.Field>
					<div class="flex items-center justify-between">
						<Label for="setting-key">
							Setting Key
							{#if !createSettingDialog.isKeyManuallyEdited && createSettingDialog.key}
								<span class="text-muted-foreground ml-2 text-xs font-normal">
									(auto-generated)
								</span>
							{/if}
						</Label>
						{#if createSettingDialog.isKeyManuallyEdited}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								class="h-6 px-2 text-xs"
								onclick={() => createSettingDialog.resetKey()}
								disabled={createSettingDialog.isPending}
							>
								<RotateCcwIcon class="mr-1 size-3" />
								Reset
							</Button>
						{/if}
					</div>
					<Input
						id="setting-key"
						bind:value={createSettingDialog.key}
						placeholder="api_url"
						disabled={createSettingDialog.isPending}
						class="font-mono text-sm"
						aria-invalid={!!createSettingDialog.error}
					/>
					{#if createSettingDialog.error}
						<Field.Error>{createSettingDialog.error}</Field.Error>
					{:else}
						<Field.Description>
							Used in code. Must be lowercase with underscores.
						</Field.Description>
					{/if}
				</Field.Field>
			</div>

			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					onclick={() => createSettingDialog.cancel()}
					disabled={createSettingDialog.isPending}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					disabled={createSettingDialog.isPending ||
						!createSettingDialog.canConfirm}
				>
					Create
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
