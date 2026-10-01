/** An application that names the browser entry itself. */
import { defineFolder, openFolder } from '@epicenter/folder/browser';

const definition = defineFolder({
	id: 'so.epicenter.bundlefixture',
	kv: {},
	tables: {},
});

export const start = () => openFolder({ definition });
