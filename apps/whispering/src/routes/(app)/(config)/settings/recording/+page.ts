import { desktopRpc } from '$lib/query';

export const load = async () => {
	const { data: ffmpegInstalled } =
		await desktopRpc.ffmpeg.checkFfmpegInstalled.ensure();

	return {
		ffmpegInstalled: ffmpegInstalled === true,
	};
};
