<script lang="ts">
	import {
		AnthropicApiKeyInput,
		ElevenLabsApiKeyInput,
		GoogleApiKeyInput,
		GroqApiKeyInput,
		MistralApiKeyInput,
		DeepgramApiKeyInput,
		OpenAiApiKeyInput,
		OpenRouterApiKeyInput,
		CustomEndpointInput,
	} from '$lib/components/settings';
	import { Badge } from '@epicenter/ui/badge';
	import * as Field from '@epicenter/ui/field';
	import * as Tabs from '@epicenter/ui/tabs';
</script>

<svelte:head>
	<title>API Keys - Whispering</title>
</svelte:head>

<Field.Set>
	<Field.Legend>API Keys</Field.Legend>
	<Field.Description>Configure your API keys for Whispering.</Field.Description>
	<Field.Separator />

	<Tabs.Root value="all" class="w-full">
		<Tabs.List class="grid w-full grid-cols-3">
			<Tabs.Trigger value="all">
				All
				<Badge variant="secondary">9</Badge>
			</Tabs.Trigger>
			<Tabs.Trigger value="transcription">
				Transcription
				<Badge variant="secondary">5</Badge>
			</Tabs.Trigger>
			<Tabs.Trigger value="transformation">
				Transformation
				<Badge variant="secondary">7</Badge>
			</Tabs.Trigger>
		</Tabs.List>

		<!-- All Tab -->
		<Tabs.Content value="all" class="mt-4">
			<Field.Group>
				<GroqApiKeyInput />
				<Field.Separator />
				<OpenAiApiKeyInput />
				<Field.Separator />
				<ElevenLabsApiKeyInput />
				<Field.Separator />
				<DeepgramApiKeyInput />
				<Field.Separator />
				<MistralApiKeyInput />
				<Field.Separator />
				<GoogleApiKeyInput />
				<Field.Separator />
				<AnthropicApiKeyInput />
				<Field.Separator />
				<OpenRouterApiKeyInput />
				<Field.Separator />
				<CustomEndpointInput />
			</Field.Group>
		</Tabs.Content>

		<!-- Transcription Tab -->
		<Tabs.Content value="transcription" class="mt-4">
			<Field.Group>
				<GroqApiKeyInput />
				<Field.Separator />
				<OpenAiApiKeyInput />
				<Field.Separator />
				<ElevenLabsApiKeyInput />
				<Field.Separator />
				<DeepgramApiKeyInput />
				<Field.Separator />
				<MistralApiKeyInput />
			</Field.Group>
		</Tabs.Content>

		<!-- Transformation Tab -->
		<Tabs.Content value="transformation" class="mt-4">
			<Field.Group>
				<GoogleApiKeyInput />
				<Field.Separator />
				<AnthropicApiKeyInput />
				<Field.Separator />
				<OpenAiApiKeyInput />
				<Field.Separator />
				<GroqApiKeyInput />
				<Field.Separator />
				<MistralApiKeyInput />
				<Field.Separator />
				<OpenRouterApiKeyInput />
				<Field.Separator />
				<CustomEndpointInput />
			</Field.Group>
		</Tabs.Content>
	</Tabs.Root>
</Field.Set>
