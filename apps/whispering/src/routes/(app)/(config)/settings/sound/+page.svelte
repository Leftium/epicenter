<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { Switch } from '@epicenter/ui/switch';
	import { settings } from '$lib/state/settings.svelte';
</script>

<svelte:head>
	<title>Sound Settings - Whispering</title>
</svelte:head>

<Field.Set>
	<Field.Legend>Sound</Field.Legend>
	<Field.Description>
		Configure your Whispering sound preferences.
	</Field.Description>
	<Field.Separator />
	<Field.Group>
		<Field.Set>
			<Field.Legend variant="label">Manual Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for manual recording events.
			</Field.Description>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.manual-start"
						bind:checked={
							() => settings.value['sound.playOn.manual-start'],
							(v) => settings.updateKey('sound.playOn.manual-start', v)
						}
					/>
					<Field.Label for="sound.playOn.manual-start">
						Play sound when starting manual recording
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.manual-stop"
						bind:checked={
							() => settings.value['sound.playOn.manual-stop'],
							(v) => settings.updateKey('sound.playOn.manual-stop', v)
						}
					/>
					<Field.Label for="sound.playOn.manual-stop">
						Play sound when stopping manual recording
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.manual-cancel"
						bind:checked={
							() => settings.value['sound.playOn.manual-cancel'],
							(v) => settings.updateKey('sound.playOn.manual-cancel', v)
						}
					/>
					<Field.Label for="sound.playOn.manual-cancel">
						Play sound when canceling manual recording
					</Field.Label>
				</Field.Field>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">VAD Recording Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for voice-activated detection events.
			</Field.Description>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.vad-start"
						bind:checked={
							() => settings.value['sound.playOn.vad-start'],
							(v) => settings.updateKey('sound.playOn.vad-start', v)
						}
					/>
					<Field.Label for="sound.playOn.vad-start">
						Play sound when starting VAD recording session
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.vad-capture"
						bind:checked={
							() => settings.value['sound.playOn.vad-capture'],
							(v) => settings.updateKey('sound.playOn.vad-capture', v)
						}
					/>
					<Field.Label for="sound.playOn.vad-capture">
						Play sound on VAD capture
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="sound.playOn.vad-stop"
						bind:checked={
							() => settings.value['sound.playOn.vad-stop'],
							(v) => settings.updateKey('sound.playOn.vad-stop', v)
						}
					/>
					<Field.Label for="sound.playOn.vad-stop">
						Play sound when stopping VAD recording session
					</Field.Label>
				</Field.Field>
			</Field.Group>
		</Field.Set>

		<Field.Separator />

		<Field.Set>
			<Field.Legend variant="label">Completion Sounds</Field.Legend>
			<Field.Description>
				Configure sounds for transcription and transformation completion.
			</Field.Description>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Switch
						id="play-sound-transcription"
						bind:checked={
							() => settings.value['sound.playOn.transcriptionComplete'],
							(v) => settings.updateKey('sound.playOn.transcriptionComplete', v)
						}
					/>
					<Field.Label for="play-sound-transcription">
						Play sound after transcription
					</Field.Label>
				</Field.Field>

				<Field.Field orientation="horizontal">
					<Switch
						id="play-sound-transformation"
						bind:checked={
							() => settings.value['sound.playOn.transformationComplete'],
							(v) =>
								settings.updateKey('sound.playOn.transformationComplete', v)
						}
					/>
					<Field.Label for="play-sound-transformation">
						Play sound after transformation
					</Field.Label>
				</Field.Field>
			</Field.Group>
		</Field.Set>
	</Field.Group>
</Field.Set>
