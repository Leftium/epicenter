# Runtime Dependency Injection

## When to Read This

Read when implementing dynamic service selection based on platform or user settings.

## Runtime Dependency Injection

The consuming edge selects service implementations and injects app configuration. In Whispering this usually lives in `$lib/operations`; `$lib/rpc` only does it when the adapter directly owns the use case.

### Service Selection Pattern

```typescript
// From operations/transcribe.ts: switch between providers.
async function transcribeBlob(blob: Blob): Promise<Result<string, TranscriptionError>> {
	const selectedService = settings.get(
		'transcription.selectedTranscriptionService',
	);

	switch (selectedService) {
		case 'OpenAI':
			return await services.transcriptions.openai.transcribe(blob, {
				apiKey: deviceConfig.get('apiKeys.openai'),
				modelName: settings.get('transcription.openai.model'),
				outputLanguage: settings.get('transcription.outputLanguage'),
				prompt: settings.get('transcription.prompt'),
				temperature: settings.get('transcription.temperature'),
				baseURL: deviceConfig.get('apiEndpoints.openai') || undefined,
			});
		case 'Groq':
			return await services.transcriptions.groq.transcribe(blob, {
				apiKey: deviceConfig.get('apiKeys.groq'),
				modelName: settings.get('transcription.groq.model'),
				outputLanguage: settings.get('transcription.outputLanguage'),
				prompt: settings.get('transcription.prompt'),
				temperature: settings.get('transcription.temperature'),
			});
		default:
			return TranscriptionError.NoServiceSelected();
	}
}
```

### Recorder Service Selection

```typescript
function resolveServiceForStart(): RecorderService {
	if (
		CpalRecorderServiceLive &&
		deviceConfig.get('recording.method') === 'cpal'
	) {
		return CpalRecorderServiceLive;
	}

	return services.navigatorRecorder;
}
```

The service stays free of app state. The operation or state module reads `settings` / `deviceConfig`, chooses the implementation, and passes explicit parameters into the service.
