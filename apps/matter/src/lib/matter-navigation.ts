import { goto } from '$app/navigation';
import { routes } from './routes';

type Navigate = typeof goto;

export function createMatterNavigation({ navigate }: { navigate: Navigate }) {
	return {
		openOnboarding(): ReturnType<Navigate> {
			return navigate(routes.home());
		},
		openVault(id: string): ReturnType<Navigate> {
			return navigate(routes.vault(id));
		},
		showTable(folderName: string): ReturnType<Navigate> {
			return navigate(routes.table(folderName), {
				replaceState: true,
				keepFocus: true,
				noScroll: true,
			});
		},
	};
}

export const matterNavigation = createMatterNavigation({ navigate: goto });
