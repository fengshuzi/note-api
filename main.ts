import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, getAllTags, normalizePath } from 'obsidian';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';

interface NoteBridgeSettings {
	port: number;
	apiKey: string;
	autoStart: boolean;
}

const DEFAULT_SETTINGS: NoteBridgeSettings = {
	port: 27124,
	apiKey: '',
	autoStart: true,
};

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function generateApiKey(): string {
	return randomBytes(24).toString('hex');
}

interface NoteSummary {
	path: string;
	name: string;
	mtime: number;
	size: number;
	content?: string;
}

interface CreateNoteBody {
	path?: unknown;
	content?: unknown;
}

interface UpdateNoteBody {
	content?: unknown;
}

export default class NoteBridgePlugin extends Plugin {
	settings: NoteBridgeSettings = { ...DEFAULT_SETTINGS };
	private server: Server | null = null;

	async onload() {
		await this.loadSettings();
		if (!this.settings.apiKey) {
			this.settings.apiKey = generateApiKey();
			await this.saveSettings();
		}
		this.addSettingTab(new NoteBridgeSettingTab(this.app, this));
		this.addCommand({
			id: 'toggle-server',
			name: 'Toggle HTTP server',
			callback: () => {
				void this.toggleServer();
			},
		});
		if (this.settings.autoStart) {
			this.startServer();
		}
	}

	onunload() {
		this.stopServer();
	}

	async loadSettings() {
		const data: unknown = await this.loadData();
		if (data && typeof data === 'object') {
			const partial = data as Partial<NoteBridgeSettings>;
			this.settings = {
				port: typeof partial.port === 'number' ? partial.port : DEFAULT_SETTINGS.port,
				apiKey: typeof partial.apiKey === 'string' ? partial.apiKey : '',
				autoStart: typeof partial.autoStart === 'boolean' ? partial.autoStart : DEFAULT_SETTINGS.autoStart,
			};
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async toggleServer() {
		if (this.server) {
			this.stopServer();
			new Notice('Note API server stopped');
		} else {
			this.startServer();
		}
	}

	startServer() {
		if (this.server) {
			return;
		}
		const server = createServer((req, res) => {
			void this.handleRequest(req, res);
		});
		server.on('error', (err: Error) => {
			new Notice(`Note API failed to start on port ${this.settings.port}: ${err.message}`);
			this.server = null;
		});
		server.listen(this.settings.port, '127.0.0.1', () => {
			new Notice(`Note API server listening on 127.0.0.1:${this.settings.port}`);
		});
		this.server = server;
	}

	stopServer() {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}

	restartServer() {
		this.stopServer();
		this.startServer();
	}

	isRunning(): boolean {
		return this.server !== null;
	}

	private sendJson(res: ServerResponse, status: number, body: unknown) {
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		});
		res.end(payload);
	}

	private sendBinary(res: ServerResponse, status: number, data: Buffer, contentType: string) {
		res.writeHead(status, {
			'Content-Type': contentType,
			'Content-Length': data.length,
			'Cache-Control': 'private, max-age=60',
			'Access-Control-Allow-Origin': '*',
		});
		res.end(data);
	}

	private contentTypeFor(ext: string): string {
		const map: Record<string, string> = {
			png: 'image/png',
			jpg: 'image/jpeg',
			jpeg: 'image/jpeg',
			gif: 'image/gif',
			webp: 'image/webp',
			svg: 'image/svg+xml',
			bmp: 'image/bmp',
			avif: 'image/avif',
			pdf: 'application/pdf',
			mp3: 'audio/mpeg',
			wav: 'audio/wav',
			ogg: 'audio/ogg',
			mp4: 'video/mp4',
			mov: 'video/quicktime',
			webm: 'video/webm',
		};
		return map[ext.toLowerCase()] ?? 'application/octet-stream';
	}

	private async serveAsset(res: ServerResponse, rawPath: string) {
		const path = this.resolveNotePath(rawPath);
		if (!path) {
			this.sendJson(res, 400, { error: 'Invalid path' });
			return;
		}
		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (!(abstract instanceof TFile)) {
			this.sendJson(res, 404, { error: 'Asset not found' });
			return;
		}
		const data = await this.app.vault.readBinary(abstract);
		this.sendBinary(res, 200, Buffer.from(data), this.contentTypeFor(abstract.extension));
	}

	private async uploadAsset(req: IncomingMessage, res: ServerResponse, url: URL) {
		const filename = url.searchParams.get('filename') ?? '';
		const safeName = filename.replace(/[\\/:*?"<>|]/g, '-').trim();
		if (!safeName || safeName.includes('..')) {
			this.sendJson(res, 400, { error: 'Invalid filename' });
			return;
		}
		const folder = (url.searchParams.get('folder') ?? 'assets').replace(/\/+$/, '');
		if (folder.includes('..') || folder.startsWith('/')) {
			this.sendJson(res, 400, { error: 'Invalid folder' });
			return;
		}
		const data = await this.readBodyBuffer(req);
		if (data.length === 0) {
			this.sendJson(res, 400, { error: 'Empty body' });
			return;
		}
		await this.ensureParentFolders(`${folder}/.keep`);
		let target = `${folder}/${safeName}`;
		if (this.app.vault.getAbstractFileByPath(target)) {
			const dot = safeName.lastIndexOf('.');
			const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
			const ext = dot > 0 ? safeName.slice(dot) : '';
			target = `${folder}/${stem}-${Date.now()}${ext}`;
		}
		const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.length) as ArrayBuffer;
		const file = await this.app.vault.createBinary(target, arrayBuffer);
		this.sendJson(res, 201, { path: file.path });
	}

	private resolveLink(res: ServerResponse, url: URL) {
		const linkpath = url.searchParams.get('path') ?? '';
		const source = url.searchParams.get('source') ?? '';
		if (!linkpath) {
			this.sendJson(res, 400, { error: 'Missing "path" parameter' });
			return;
		}
		const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, source);
		if (file) {
			this.sendJson(res, 200, { path: file.path });
		} else {
			this.sendJson(res, 404, { error: 'Cannot resolve link' });
		}
	}

	private listTags(res: ServerResponse) {
		// Vault-wide tag counts from the metadata cache: independent of any
		// client-side filtering, includes frontmatter and inline tags.
		const counts: Record<string, number> = {};
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = cache ? getAllTags(cache) : null;
			if (!tags) continue;
			for (const tag of new Set(tags)) {
				counts[tag] = (counts[tag] ?? 0) + 1;
			}
		}
		const tags = Object.entries(counts)
			.map(([tag, count]) => ({ tag, count }))
			.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
		this.sendJson(res, 200, { tags });
	}

	private isAuthorized(req: IncomingMessage): boolean {
		const header = req.headers.authorization;
		let token = '';
		if (header && header.startsWith('Bearer ')) {
			token = header.slice('Bearer '.length);
		} else if (req.method === 'GET' && (req.url ?? '').startsWith('/assets/')) {
			// Rendered vault markdown may contain root-relative asset paths like
			// /assets/x.png; <img> cannot send headers. Same trust level as ?key=.
			return true;
		} else if (req.method === 'GET') {
			// <img>/<video> tags cannot send headers; allow key via query string for GET only.
			try {
				token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('key') ?? '';
			} catch {
				token = '';
			}
		}
		const expected = this.settings.apiKey;
		if (!token || token.length !== expected.length) {
			return false;
		}
		return timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expected, 'utf8'));
	}

	private readBody(req: IncomingMessage): Promise<string> {
		return this.readBodyBuffer(req).then((buf) => buf.toString('utf8'));
	}

	private readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					reject(new Error('Request body too large'));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => {
				resolve(Buffer.concat(chunks));
			});
			req.on('error', reject);
		});
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse) {
		try {
			const method = req.method ?? 'GET';
			if (method === 'OPTIONS') {
				this.sendJson(res, 204, null);
				return;
			}
			if (!this.isAuthorized(req)) {
				this.sendJson(res, 401, { error: 'Unauthorized: missing or invalid API key' });
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const path = url.pathname;

			if (method === 'GET' && path === '/api/status') {
				this.sendJson(res, 200, {
					ok: true,
					vault: this.app.vault.getName(),
					version: this.manifest.version,
				});
				return;
			}

			if (method === 'GET' && path === '/api/notes') {
				await this.listNotes(res, url);
				return;
			}

			if (method === 'GET' && path === '/api/daily-notes/config') {
				this.readDailyNotesConfig(res);
				return;
			}

			const assetPrefix = '/api/assets/';
			if (method === 'GET' && path.startsWith(assetPrefix)) {
				await this.serveAsset(res, decodeURIComponent(path.slice(assetPrefix.length)));
				return;
			}

			if (method === 'POST' && path === '/api/assets') {
				await this.uploadAsset(req, res, url);
				return;
			}

			if (method === 'GET' && path === '/api/resolve') {
				this.resolveLink(res, url);
				return;
			}

			if (method === 'GET' && path === '/api/tags') {
				this.listTags(res);
				return;
			}

			const publicAssetPrefix = '/assets/';
			if (method === 'GET' && path.startsWith(publicAssetPrefix)) {
				await this.serveAsset(res, decodeURIComponent(path.slice(1)));
				return;
			}

			const notePrefix = '/api/notes/';
			if (path.startsWith(notePrefix)) {
				const notePath = decodeURIComponent(path.slice(notePrefix.length));
				if (method === 'GET') {
					await this.readNote(res, notePath);
					return;
				}
				if (method === 'PUT') {
					await this.updateNote(req, res, notePath);
					return;
				}
				if (method === 'DELETE') {
					await this.deleteNote(res, notePath);
					return;
				}
				this.sendJson(res, 405, { error: 'Method not allowed' });
				return;
			}

			if (method === 'POST' && path === '/api/notes') {
				await this.createNote(req, res);
				return;
			}

			this.sendJson(res, 404, { error: 'Not found' });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.sendJson(res, 500, { error: message });
		}
	}

	private async listNotes(res: ServerResponse, url: URL) {
		const query = (url.searchParams.get('q') ?? '').toLowerCase();
		const folder = url.searchParams.get('folder') ?? '';
		const withContent = url.searchParams.get('content') === '1';
		const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
		const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 0;
		const notes: NoteSummary[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (folder && !file.path.startsWith(folder)) {
				continue;
			}
			if (limit && notes.length >= limit) {
				break;
			}
			const pathMatches = !query
				|| file.path.toLowerCase().includes(query)
				|| file.basename.toLowerCase().includes(query);
			let content: string | undefined;
			if (withContent || (query && !pathMatches)) {
				content = await this.app.vault.cachedRead(file);
			}
			if (!pathMatches && !(content && content.toLowerCase().includes(query))) {
				continue;
			}
			const summary: NoteSummary = {
				path: file.path,
				name: file.basename,
				mtime: file.stat.mtime,
				size: file.stat.size,
			};
			if (withContent) {
				summary.content = content;
			}
			notes.push(summary);
		}
		notes.sort((a, b) => b.mtime - a.mtime);
		this.sendJson(res, 200, { notes });
	}

	private readDailyNotesConfig(res: ServerResponse) {
		let folder = 'journals';
		let format = 'YYYY-MM-DD';
		this.app.vault.adapter
			.read(`${this.app.vault.configDir}/daily-notes.json`)
			.then((raw) => {
				try {
					const parsed = JSON.parse(raw) as { folder?: unknown; format?: unknown };
					if (typeof parsed.folder === 'string' && parsed.folder) folder = parsed.folder;
					if (typeof parsed.format === 'string' && parsed.format) format = parsed.format;
				} catch {
					// keep defaults
				}
				this.sendJson(res, 200, { folder, format });
			})
			.catch(() => {
				this.sendJson(res, 200, { folder, format });
			});
	}

	private resolveNotePath(rawPath: string): string | null {
		if (!rawPath || rawPath.includes('..') || rawPath.startsWith('/') || rawPath.includes('\\')) {
			return null;
		}
		return normalizePath(rawPath);
	}

	private getMarkdownFile(path: string): TFile | null {
		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (abstract instanceof TFile && abstract.extension === 'md') {
			return abstract;
		}
		return null;
	}

	private async readNote(res: ServerResponse, rawPath: string) {
		const path = this.resolveNotePath(rawPath);
		if (!path) {
			this.sendJson(res, 400, { error: 'Invalid path' });
			return;
		}
		const file = this.getMarkdownFile(path);
		if (!file) {
			this.sendJson(res, 404, { error: 'Note not found' });
			return;
		}
		const content = await this.app.vault.read(file);
		this.sendJson(res, 200, {
			path: file.path,
			name: file.basename,
			mtime: file.stat.mtime,
			size: file.stat.size,
			content,
		});
	}

	private async createNote(req: IncomingMessage, res: ServerResponse) {
		const body = await this.readBody(req);
		let parsed: CreateNoteBody;
		try {
			parsed = JSON.parse(body) as CreateNoteBody;
		} catch {
			this.sendJson(res, 400, { error: 'Invalid JSON body' });
			return;
		}
		if (typeof parsed.path !== 'string') {
			this.sendJson(res, 400, { error: 'Missing "path" string field' });
			return;
		}
		const path = this.resolveNotePath(parsed.path);
		if (!path || !path.endsWith('.md')) {
			this.sendJson(res, 400, { error: 'Path must be a vault-relative .md path' });
			return;
		}
		const content = typeof parsed.content === 'string' ? parsed.content : '';
		if (this.app.vault.getAbstractFileByPath(path)) {
			this.sendJson(res, 409, { error: 'A file already exists at this path' });
			return;
		}
		await this.ensureParentFolders(path);
		const file = await this.app.vault.create(path, content);
		this.sendJson(res, 201, { path: file.path, mtime: file.stat.mtime });
	}

	private async ensureParentFolders(path: string) {
		const parts = path.split('/');
		parts.pop();
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`Cannot create folder: ${current} is a file`);
			}
		}
	}

	private async updateNote(req: IncomingMessage, res: ServerResponse, rawPath: string) {
		const path = this.resolveNotePath(rawPath);
		if (!path) {
			this.sendJson(res, 400, { error: 'Invalid path' });
			return;
		}
		const file = this.getMarkdownFile(path);
		if (!file) {
			this.sendJson(res, 404, { error: 'Note not found' });
			return;
		}
		const body = await this.readBody(req);
		let parsed: UpdateNoteBody;
		try {
			parsed = JSON.parse(body) as UpdateNoteBody;
		} catch {
			this.sendJson(res, 400, { error: 'Invalid JSON body' });
			return;
		}
		if (typeof parsed.content !== 'string') {
			this.sendJson(res, 400, { error: 'Missing "content" string field' });
			return;
		}
		await this.app.vault.modify(file, parsed.content);
		this.sendJson(res, 200, { path: file.path, mtime: file.stat.mtime });
	}

	private async deleteNote(res: ServerResponse, rawPath: string) {
		const path = this.resolveNotePath(rawPath);
		if (!path) {
			this.sendJson(res, 400, { error: 'Invalid path' });
			return;
		}
		const file = this.getMarkdownFile(path);
		if (!file) {
			this.sendJson(res, 404, { error: 'Note not found' });
			return;
		}
		await this.app.fileManager.trashFile(file);
		this.sendJson(res, 200, { deleted: path });
	}
}

class NoteBridgeSettingTab extends PluginSettingTab {
	plugin: NoteBridgePlugin;

	constructor(app: App, plugin: NoteBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('note-api-settings');

		const statusText = this.plugin.isRunning()
			? `Running on http://127.0.0.1:${this.plugin.settings.port}`
			: 'Stopped';
		new Setting(containerEl)
			.setName('Server status')
			.setDesc(statusText)
			.addButton((button) =>
				button
					.setButtonText(this.plugin.isRunning() ? 'Stop' : 'Start')
					.onClick(() => {
						void this.plugin.toggleServer().then(() => this.display());
					})
			);

		new Setting(containerEl)
			.setName('Port')
			.setDesc('Localhost port for the HTTP API. Restart required.')
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.port))
					.setValue(String(this.plugin.settings.port))
					.onChange(async (value) => {
						const port = Number.parseInt(value, 10);
						if (Number.isInteger(port) && port > 1024 && port < 65536) {
							this.plugin.settings.port = port;
							await this.plugin.saveSettings();
						}
					})
			)
			.addButton((button) =>
				button.setButtonText('Apply & restart').onClick(() => {
					this.plugin.restartServer();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Required for every request: Authorization: Bearer <key>')
			.addText((text) => {
				text.setValue(this.plugin.settings.apiKey).onChange(async (value) => {
					this.plugin.settings.apiKey = value.trim();
					await this.plugin.saveSettings();
				});
				text.inputEl.type = 'password';
				text.inputEl.addClass('note-api-api-key-input');
			})
			.addButton((button) =>
				button.setButtonText('Copy').onClick(() => {
					void navigator.clipboard.writeText(this.plugin.settings.apiKey).then(() => {
						new Notice('API key copied');
					});
				})
			)
			.addButton((button) =>
				button
					.setButtonText('Regenerate')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.apiKey = generateApiKey();
						await this.plugin.saveSettings();
						new Notice('New API key generated');
						this.display();
					})
			);

		new Setting(containerEl)
			.setName('Start on launch')
			.setDesc('Automatically start the HTTP server when the vault opens.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
					this.plugin.settings.autoStart = value;
					await this.plugin.saveSettings();
				})
			);

		const donateSection = containerEl.createDiv({ cls: 'note-api-donate' });
		const imgWrap = donateSection.createDiv({ cls: 'plugin-donate-qr' });
		const donateImgSrc = 'https://raw.githubusercontent.com/fengshuzi/images/main/wechat-donate.jpg';
		const donateImg = imgWrap.createEl('img', {
			attr: { src: donateImgSrc, alt: '微信打赏' },
			cls: 'plugin-donate-img',
		});
		donateImg.addEventListener('click', () => {
			const overlay = document.body.createDiv({ cls: 'plugin-donate-lightbox' });
			overlay.createEl('img', {
				attr: { src: donateImgSrc, alt: '微信打赏' },
				cls: 'plugin-donate-lightbox-img',
			});
			overlay.addEventListener('click', () => overlay.remove());
		});
	}
}
