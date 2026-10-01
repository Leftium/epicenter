/** An application that names the desktop entry itself. */
import { defineFolder, openFolder } from '@epicenter/folder/tauri';

const definition = defineFolder({
	id: 'so.epicenter.bundlefixture',
	kv: {},
	tables: {},
});

export const start = () => openFolder({ definition });
