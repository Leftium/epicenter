import tauri from '$lib/tauri';

export const load = async () => {
	if (!tauri) return { ffmpegInstalled: false };
	const { data: ffmpegInstalled } =
		await tauri.rpc.ffmpeg.checkInstalled.ensure();

	return {
		ffmpegInstalled: ffmpegInstalled === true,
	};
};
