import { describe, expect, test } from 'bun:test';
import { Bash } from 'just-bash';
import { createWorkspace } from '@epicenter/hq/static';
import { filesTable } from './file-table.js';
import { createTimeline } from './timeline-helpers.js';
import { YjsFileSystem } from './yjs-file-system.js';

function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	return YjsFileSystem.create(ws.tables.files);
}

describe('YjsFileSystem', () => {
	describe('exists', () => {
		test('root always exists', async () => {
			const fs = setup();
			expect(await fs.exists('/')).toBe(true);
		});

		test('nonexistent path', async () => {
			const fs = setup();
			expect(await fs.exists('/nope')).toBe(false);
		});
	});

	describe('writeFile + readFile', () => {
		test('create and read a file', async () => {
			const fs = setup();
			await fs.writeFile('/hello.txt', 'Hello World');
			const content = await fs.readFile('/hello.txt');
			expect(content).toBe('Hello World');
		});

		test('overwrite existing file', async () => {
			const fs = setup();
			await fs.writeFile('/file.txt', 'first');
			await fs.writeFile('/file.txt', 'second');
			expect(await fs.readFile('/file.txt')).toBe('second');
		});

		test('readFile on nonexistent throws ENOENT', async () => {
			const fs = setup();
			await expect(fs.readFile('/nope')).rejects.toThrow('ENOENT');
		});

		test('readFile on directory throws EISDIR', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			await expect(fs.readFile('/dir')).rejects.toThrow('EISDIR');
		});

		test('writeFile on existing directory throws EISDIR', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			await expect(fs.writeFile('/dir', 'content')).rejects.toThrow('EISDIR');
		});
	});

	describe('appendFile', () => {
		test('append to existing file', async () => {
			const fs = setup();
			await fs.writeFile('/file.txt', 'Hello');
			await fs.appendFile('/file.txt', ' World');
			expect(await fs.readFile('/file.txt')).toBe('Hello World');
		});

		test('append creates file if not exists', async () => {
			const fs = setup();
			await fs.appendFile('/new.txt', 'content');
			expect(await fs.readFile('/new.txt')).toBe('content');
		});

		test('append to directory throws EISDIR', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			await expect(fs.appendFile('/dir', 'data')).rejects.toThrow('EISDIR');
		});

		test('multiple appends accumulate content', async () => {
			const fs = setup();
			await fs.writeFile('/log.txt', 'line1\n');
			await fs.appendFile('/log.txt', 'line2\n');
			await fs.appendFile('/log.txt', 'line3\n');
			expect(await fs.readFile('/log.txt')).toBe('line1\nline2\nline3\n');
		});
	});

	describe('stat', () => {
		test('stat root', async () => {
			const fs = setup();
			const s = await fs.stat('/');
			expect(s.isDirectory).toBe(true);
			expect(s.isFile).toBe(false);
		});

		test('stat file', async () => {
			const fs = setup();
			await fs.writeFile('/hello.txt', 'Hi');
			const s = await fs.stat('/hello.txt');
			expect(s.isFile).toBe(true);
			expect(s.isDirectory).toBe(false);
			expect(s.size).toBe(2);
			expect(s.mode).toBe(0o644);
		});

		test('stat directory', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			const s = await fs.stat('/dir');
			expect(s.isDirectory).toBe(true);
			expect(s.mode).toBe(0o755);
		});

		test('stat nonexistent throws ENOENT', async () => {
			const fs = setup();
			await expect(fs.stat('/nope')).rejects.toThrow('ENOENT');
		});
	});

	describe('mkdir', () => {
		test('create directory', async () => {
			const fs = setup();
			await fs.mkdir('/docs');
			expect(await fs.exists('/docs')).toBe(true);
			const s = await fs.stat('/docs');
			expect(s.isDirectory).toBe(true);
		});

		test('mkdir -p (recursive)', async () => {
			const fs = setup();
			await fs.mkdir('/a/b/c', { recursive: true });
			expect(await fs.exists('/a')).toBe(true);
			expect(await fs.exists('/a/b')).toBe(true);
			expect(await fs.exists('/a/b/c')).toBe(true);
		});

		test('mkdir on existing dir is no-op', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			await fs.mkdir('/dir'); // should not throw
			expect(await fs.exists('/dir')).toBe(true);
		});

		test('mkdir on existing file throws EEXIST', async () => {
			const fs = setup();
			await fs.writeFile('/file.txt', 'content');
			await expect(fs.mkdir('/file.txt')).rejects.toThrow('EEXIST');
		});

		test('mkdir -p through existing file throws ENOTDIR', async () => {
			const fs = setup();
			await fs.writeFile('/file.txt', 'content');
			await expect(
				fs.mkdir('/file.txt/sub', { recursive: true }),
			).rejects.toThrow('ENOTDIR');
		});

		test('mkdir -p through existing directories is no-op for existing', async () => {
			const fs = setup();
			await fs.mkdir('/a', { recursive: true });
			await fs.mkdir('/a/b/c', { recursive: true });
			expect(await fs.exists('/a/b/c')).toBe(true);
		});
	});

	describe('readdir', () => {
		test('readdir root', async () => {
			const fs = setup();
			await fs.writeFile('/a.txt', 'a');
			await fs.writeFile('/b.txt', 'b');
			const entries = await fs.readdir('/');
			expect(entries).toEqual(['a.txt', 'b.txt']);
		});

		test('readdir nested', async () => {
			const fs = setup();
			await fs.mkdir('/docs');
			await fs.writeFile('/docs/api.md', '# API');
			await fs.writeFile('/docs/readme.md', '# README');
			const entries = await fs.readdir('/docs');
			expect(entries).toEqual(['api.md', 'readme.md']);
		});

		test('readdir on file throws ENOTDIR', async () => {
			const fs = setup();
			await fs.writeFile('/file.txt', 'content');
			await expect(fs.readdir('/file.txt')).rejects.toThrow('ENOTDIR');
		});
	});

	describe('rm', () => {
		test('rm file (soft delete)', async () => {
			const fs = setup();
			await fs.writeFile('/file.txt', 'content');
			await fs.rm('/file.txt');
			expect(await fs.exists('/file.txt')).toBe(false);
		});

		test('rm -rf directory', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			await fs.writeFile('/dir/file.txt', 'content');
			await fs.rm('/dir', { recursive: true });
			expect(await fs.exists('/dir')).toBe(false);
			expect(await fs.exists('/dir/file.txt')).toBe(false);
		});

		test('rm nonexistent throws ENOENT', async () => {
			const fs = setup();
			await expect(fs.rm('/nope')).rejects.toThrow('ENOENT');
		});

		test('rm --force nonexistent is no-op', async () => {
			const fs = setup();
			await fs.rm('/nope', { force: true }); // should not throw
		});

		test('rm non-empty dir without recursive throws ENOTEMPTY', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			await fs.writeFile('/dir/file.txt', 'content');
			await expect(fs.rm('/dir')).rejects.toThrow('ENOTEMPTY');
		});
	});

	describe('mv', () => {
		test('rename file', async () => {
			const fs = setup();
			await fs.writeFile('/old.txt', 'content');
			await fs.mv('/old.txt', '/new.txt');
			expect(await fs.exists('/old.txt')).toBe(false);
			expect(await fs.exists('/new.txt')).toBe(true);
		});

		test('move file to directory', async () => {
			const fs = setup();
			await fs.mkdir('/dir');
			await fs.writeFile('/file.txt', 'content');
			await fs.mv('/file.txt', '/dir/file.txt');
			expect(await fs.exists('/file.txt')).toBe(false);
			expect(await fs.exists('/dir/file.txt')).toBe(true);
			expect(await fs.readFile('/dir/file.txt')).toBe('content');
		});
	});

	describe('cp', () => {
		test('copy file', async () => {
			const fs = setup();
			await fs.writeFile('/src.txt', 'content');
			await fs.cp('/src.txt', '/dest.txt');
			expect(await fs.readFile('/dest.txt')).toBe('content');
			expect(await fs.readFile('/src.txt')).toBe('content');
		});

		test('copy directory recursively', async () => {
			const fs = setup();
			await fs.mkdir('/src');
			await fs.writeFile('/src/a.txt', 'aaa');
			await fs.writeFile('/src/b.txt', 'bbb');
			await fs.cp('/src', '/dest', { recursive: true });
			expect(await fs.readFile('/dest/a.txt')).toBe('aaa');
			expect(await fs.readFile('/dest/b.txt')).toBe('bbb');
		});
	});

	describe('resolvePath', () => {
		test('resolves relative paths', () => {
			const fs = setup();
			expect(fs.resolvePath('/docs', 'api.md')).toBe('/docs/api.md');
			expect(fs.resolvePath('/docs', '../src/index.ts')).toBe('/src/index.ts');
			expect(fs.resolvePath('/docs', '/absolute')).toBe('/absolute');
		});
	});

	describe('getAllPaths', () => {
		test('returns all paths except root', async () => {
			const fs = setup();
			await fs.mkdir('/docs');
			await fs.writeFile('/docs/api.md', '# API');
			const paths = fs.getAllPaths();
			expect(paths).toContain('/docs');
			expect(paths).toContain('/docs/api.md');
			expect(paths).not.toContain('/');
		});
	});

	describe('chmod', () => {
		test('no-op but verifies file exists', async () => {
			const fs = setup();
			await fs.writeFile('/file.txt', 'content');
			await fs.chmod('/file.txt', 0o755); // should not throw
		});

		test('chmod on nonexistent throws ENOENT', async () => {
			const fs = setup();
			await expect(fs.chmod('/nope', 0o755)).rejects.toThrow('ENOENT');
		});
	});

	describe('symlink / link / readlink', () => {
		test('symlink throws ENOSYS', async () => {
			const fs = setup();
			await expect((fs as any).symlink('/target', '/link')).rejects.toThrow(
				'ENOSYS',
			);
		});

		test('link throws ENOSYS', async () => {
			const fs = setup();
			await expect((fs as any).link('/existing', '/new')).rejects.toThrow(
				'ENOSYS',
			);
		});

		test('readlink throws ENOSYS', async () => {
			const fs = setup();
			await expect((fs as any).readlink('/link')).rejects.toThrow('ENOSYS');
		});
	});
});

describe('binary file support', () => {
	test('writeFile with Uint8Array, readFileBuffer returns same bytes', async () => {
		const fs = setup();
		const data = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]); // "SQLite"
		await fs.writeFile('/db.sqlite', data);
		const result = await fs.readFileBuffer('/db.sqlite');
		expect(result).toEqual(data);
	});

	test('readFile on binary file returns decoded string', async () => {
		const fs = setup();
		const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
		await fs.writeFile('/file.bin', data);
		expect(await fs.readFile('/file.bin')).toBe('Hello');
	});

	test('text writeFile clears binary data', async () => {
		const fs = setup();
		const data = new Uint8Array([1, 2, 3]);
		await fs.writeFile('/file.txt', data);
		// Now overwrite with text
		await fs.writeFile('/file.txt', 'text content');
		expect(await fs.readFile('/file.txt')).toBe('text content');
	});

	test('cp copies binary file', async () => {
		const fs = setup();
		const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
		await fs.writeFile('/src.bin', data);
		await fs.cp('/src.bin', '/dest.bin');
		expect(await fs.readFileBuffer('/dest.bin')).toEqual(data);
	});

	test('rm cleans up binary data', async () => {
		const fs = setup();
		const data = new Uint8Array([1, 2, 3]);
		await fs.writeFile('/file.bin', data);
		await fs.rm('/file.bin');
		expect(await fs.exists('/file.bin')).toBe(false);
	});
});

describe('mv preserves content (no conversion)', () => {
	test('mv .txt -> .md preserves content exactly', async () => {
		const fs = setup();
		await fs.writeFile('/notes.txt', '---\ntitle: Hello\n---\n# Content\n');
		await fs.mv('/notes.txt', '/notes.md');
		expect(await fs.readFile('/notes.md')).toBe(
			'---\ntitle: Hello\n---\n# Content\n',
		);
	});

	test('mv .md -> .txt preserves content exactly', async () => {
		const fs = setup();
		await fs.writeFile('/doc.md', '# Hello World\n');
		await fs.mv('/doc.md', '/doc.txt');
		expect(await fs.readFile('/doc.txt')).toBe('# Hello World\n');
	});
});

async function getTimelineLength(
	fs: YjsFileSystem,
	path: string,
): Promise<number> {
	const tree = (fs as any).tree;
	const content = (fs as any).content;
	const id = tree.lookupId(path);
	const ydoc = await content.store.ensure(id);
	return createTimeline(ydoc).length;
}

describe('timeline content storage', () => {
	test('binary file persistence (write binary, read back)', async () => {
		const fs = setup();
		const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
		await fs.writeFile('/image.png', data);
		expect(await fs.readFileBuffer('/image.png')).toEqual(data);
		expect(await fs.readFile('/image.png')).toBe(
			new TextDecoder().decode(data),
		);
	});

	test('mode switching: text → binary → text', async () => {
		const fs = setup();
		await fs.writeFile('/file.dat', 'hello text');
		expect(await fs.readFile('/file.dat')).toBe('hello text');

		const binary = new Uint8Array([0xde, 0xad]);
		await fs.writeFile('/file.dat', binary);
		expect(await fs.readFileBuffer('/file.dat')).toEqual(binary);

		await fs.writeFile('/file.dat', 'back to text');
		expect(await fs.readFile('/file.dat')).toBe('back to text');
	});

	test('mode switching: binary → text', async () => {
		const fs = setup();
		const binary = new Uint8Array([0x01, 0x02, 0x03]);
		await fs.writeFile('/file.bin', binary);
		await fs.writeFile('/file.bin', 'now text');
		expect(await fs.readFile('/file.bin')).toBe('now text');
	});

	test('text append (appendFile on text entry)', async () => {
		const fs = setup();
		await fs.writeFile('/log.txt', 'line1\n');
		await fs.appendFile('/log.txt', 'line2\n');
		expect(await fs.readFile('/log.txt')).toBe('line1\nline2\n');
		// Append to text should not grow timeline
		expect(await getTimelineLength(fs, '/log.txt')).toBe(1);
	});

	test('binary append (appendFile on binary entry becomes text)', async () => {
		const fs = setup();
		const binary = new Uint8Array([0x48, 0x69]); // "Hi"
		await fs.writeFile('/file.bin', binary);
		await fs.appendFile('/file.bin', ' there');
		expect(await fs.readFile('/file.bin')).toBe('Hi there');
		// Binary append pushes a new text entry
		expect(await getTimelineLength(fs, '/file.bin')).toBe(2);
	});

	test('timeline inspection: entry count after mode switches', async () => {
		const fs = setup();
		// First write: text entry [0]
		await fs.writeFile('/file.dat', 'text v1');
		expect(await getTimelineLength(fs, '/file.dat')).toBe(1);

		// Binary write: new entry [1]
		await fs.writeFile('/file.dat', new Uint8Array([1, 2, 3]));
		expect(await getTimelineLength(fs, '/file.dat')).toBe(2);

		// Back to text: new entry [2]
		await fs.writeFile('/file.dat', 'text v2');
		expect(await getTimelineLength(fs, '/file.dat')).toBe(3);
	});

	test('same-mode text overwrite does NOT grow timeline', async () => {
		const fs = setup();
		await fs.writeFile('/file.txt', 'first');
		await fs.writeFile('/file.txt', 'second');
		await fs.writeFile('/file.txt', 'third');
		expect(await fs.readFile('/file.txt')).toBe('third');
		expect(await getTimelineLength(fs, '/file.txt')).toBe(1);
	});

	test('same-mode binary overwrite DOES grow timeline', async () => {
		const fs = setup();
		await fs.writeFile('/file.bin', new Uint8Array([1]));
		await fs.writeFile('/file.bin', new Uint8Array([2]));
		await fs.writeFile('/file.bin', new Uint8Array([3]));
		expect(await fs.readFileBuffer('/file.bin')).toEqual(new Uint8Array([3]));
		expect(await getTimelineLength(fs, '/file.bin')).toBe(3);
	});

	test('readFileBuffer returns correct bytes for text entry', async () => {
		const fs = setup();
		await fs.writeFile('/file.txt', 'hello');
		const buf = await fs.readFileBuffer('/file.txt');
		expect(buf).toEqual(new TextEncoder().encode('hello'));
	});

	test('readFileBuffer returns correct bytes for binary entry', async () => {
		const fs = setup();
		const data = new Uint8Array([0xff, 0xfe, 0xfd]);
		await fs.writeFile('/file.bin', data);
		expect(await fs.readFileBuffer('/file.bin')).toEqual(data);
	});
});

describe('just-bash integration', () => {
	function setupBash() {
		const fs = setup();
		return new Bash({ fs, cwd: '/' });
	}

	test('echo + cat', async () => {
		const bash = setupBash();
		await bash.exec('echo "hello world" > /greeting.txt');
		const result = await bash.exec('cat /greeting.txt');
		expect(result.stdout.trim()).toBe('hello world');
	});

	test('mkdir -p + ls', async () => {
		const bash = setupBash();
		await bash.exec('mkdir -p /docs/nested');
		const result = await bash.exec('ls /docs');
		expect(result.stdout.trim()).toBe('nested');
	});

	test('find', async () => {
		const bash = setupBash();
		await bash.exec('mkdir -p /src');
		await bash.exec('echo "ts" > /src/index.ts');
		await bash.exec('echo "md" > /src/readme.md');
		const result = await bash.exec('find / -name "*.ts"');
		expect(result.stdout.trim()).toContain('/src/index.ts');
	});

	test('grep', async () => {
		const bash = setupBash();
		await bash.exec('echo "TODO: fix this" > /file.txt');
		await bash.exec('echo "all good" > /other.txt');
		const result = await bash.exec('grep -r "TODO" /');
		expect(result.stdout).toContain('TODO');
		expect(result.stdout).toContain('/file.txt');
	});

	test('rm -rf', async () => {
		const bash = setupBash();
		await bash.exec('mkdir -p /dir/sub');
		await bash.exec('echo "x" > /dir/sub/file.txt');
		await bash.exec('rm -rf /dir');
		const result = await bash.exec('ls /');
		expect(result.stdout.trim()).toBe('');
	});

	test('mv (rename)', async () => {
		const bash = setupBash();
		await bash.exec('echo "content" > /old.txt');
		await bash.exec('mv /old.txt /new.txt');
		const result = await bash.exec('cat /new.txt');
		expect(result.stdout.trim()).toBe('content');
	});

	test('cp', async () => {
		const bash = setupBash();
		await bash.exec('echo "content" > /src.txt');
		await bash.exec('cp /src.txt /dest.txt');
		const result = await bash.exec('cat /dest.txt');
		expect(result.stdout.trim()).toBe('content');
	});

	test('wc -l', async () => {
		const bash = setupBash();
		await bash.exec('printf "line1\\nline2\\nline3\\n" > /file.txt');
		const result = await bash.exec('wc -l /file.txt');
		expect(result.stdout.trim()).toContain('3');
	});
});
