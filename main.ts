import { App, Notice, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TFile, TFolder, getAllTags, moment, normalizePath } from 'obsidian';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';
import { completeReminder, createReminder, deleteReminder, listReminderLists, listReminders, updateReminder } from './reminders';
import {
	createCalendarEvent as createCalendarEventInStore,
	deleteCalendarEvent as deleteCalendarEventInStore,
	listCalendarEvents as listCalendarEventsFromStore,
	listCalendarNames,
	updateCalendarEvent as updateCalendarEventInStore,
} from './calendar';

interface NoteBridgeSettings {
	port: number;
	apiKey: string;
	autoStart: boolean;
	enableReminders: boolean;
}

const DEFAULT_SETTINGS: NoteBridgeSettings = {
	port: 27124,
	apiKey: '',
	autoStart: true,
	enableReminders: false,
};

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function generateApiKey(): string {
	// Shared default key so note-tab and other clients work out of the box.
	// Users worried about exposure should regenerate from settings.
	return 'addwxfengshu4511';
}

interface NoteSummary {
	path: string;
	name: string;
	mtime: number;
	size: number;
	content?: string;
}

interface DailyNotesConfig {
	folder: string;
	format: string;
}

interface CreateNoteBody {
	path?: unknown;
	content?: unknown;
}

interface UpdateNoteBody {
	content?: unknown;
}

interface CreateReminderBody {
	title?: unknown;
	due?: unknown;
	list?: unknown;
}

interface UpdateReminderBody {
	title?: unknown;
	due?: unknown;
	completed?: unknown;
}

interface CreateCalendarEventBody {
	title?: unknown;
	start?: unknown;
	end?: unknown;
	calendar?: unknown;
}

interface UpdateCalendarEventBody {
	title?: unknown;
	start?: unknown;
	end?: unknown;
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
				enableReminders: typeof partial.enableReminders === 'boolean' ? partial.enableReminders : DEFAULT_SETTINGS.enableReminders,
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

	// Reminders handlers delegate to reminders.ts (macOS EventKit via JXA).
	// "Reminder not found" maps to 404, the macOS-only guard to 501, anything
	// else falls through to the generic 500 in handleRequest.
	private async withReminderErrors(res: ServerResponse, fn: () => Promise<void>) {
		try {
			await fn();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === 'Reminder not found') {
				this.sendJson(res, 404, { error: message });
				return;
			}
			if (message.includes('only available on macOS')) {
				this.sendJson(res, 501, { error: message });
				return;
			}
			throw err;
		}
	}

	private async listReminders(res: ServerResponse, url: URL) {
		await this.withReminderErrors(res, async () => {
			const list = url.searchParams.get('list') ?? undefined;
			const [reminders, lists] = await Promise.all([listReminders(list), listReminderLists()]);
			this.sendJson(res, 200, { reminders, lists });
		});
	}

	private async createReminder(req: IncomingMessage, res: ServerResponse) {
		const body = await this.readBody(req);
		let parsed: CreateReminderBody;
		try {
			parsed = JSON.parse(body) as CreateReminderBody;
		} catch {
			this.sendJson(res, 400, { error: 'Invalid JSON body' });
			return;
		}
		if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
			this.sendJson(res, 400, { error: 'Missing "title" string field' });
			return;
		}
		const title = parsed.title.trim();
		const due = typeof parsed.due === 'string' && parsed.due ? parsed.due : undefined;
		const list = typeof parsed.list === 'string' ? parsed.list : undefined;
		await this.withReminderErrors(res, async () => {
			await createReminder(title, list, due);
			this.sendJson(res, 201, { ok: true });
		});
	}

	private async updateReminder(req: IncomingMessage, res: ServerResponse, id: string) {
		if (!id) {
			this.sendJson(res, 400, { error: 'Missing reminder id' });
			return;
		}
		const body = await this.readBody(req);
		let parsed: UpdateReminderBody;
		try {
			parsed = JSON.parse(body) as UpdateReminderBody;
		} catch {
			this.sendJson(res, 400, { error: 'Invalid JSON body' });
			return;
		}
		await this.withReminderErrors(res, async () => {
			if (parsed.completed === true) {
				await completeReminder(id);
			} else {
				if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
					this.sendJson(res, 400, { error: 'Missing "title" string field' });
					return;
				}
				const due = typeof parsed.due === 'string' && parsed.due ? parsed.due : undefined;
				await updateReminder(id, parsed.title.trim(), due);
			}
			this.sendJson(res, 200, { ok: true });
		});
	}

	private async deleteReminder(res: ServerResponse, id: string) {
		if (!id) {
			this.sendJson(res, 400, { error: 'Missing reminder id' });
			return;
		}
		await this.withReminderErrors(res, async () => {
			await deleteReminder(id);
			this.sendJson(res, 200, { ok: true });
		});
	}

	// Calendar handlers delegate to calendar.ts (macOS EventKit via JXA).
	// "Event not found" maps to 404, the macOS-only guard to 501, anything
	// else falls through to the generic 500 in handleRequest.
	private async withCalendarErrors(res: ServerResponse, fn: () => Promise<void>) {
		try {
			await fn();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === 'Event not found') {
				this.sendJson(res, 404, { error: message });
				return;
			}
			if (message.includes('only available on macOS')) {
				this.sendJson(res, 501, { error: message });
				return;
			}
			throw err;
		}
	}

	private async listCalendarEvents(res: ServerResponse, url: URL) {
		await this.withCalendarErrors(res, async () => {
			const startParam = url.searchParams.get('start');
			const endParam = url.searchParams.get('end');
			// Default: 3 days starting today (same window as lite-calendar).
			const start = startParam || new Date().toISOString();
			const end = endParam || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
			const [events, calendars] = await Promise.all([
				listCalendarEventsFromStore(start, end),
				listCalendarNames(),
			]);
			this.sendJson(res, 200, { events, calendars });
		});
	}

	private async createCalendarEvent(req: IncomingMessage, res: ServerResponse) {
		const body = await this.readBody(req);
		let parsed: CreateCalendarEventBody;
		try {
			parsed = JSON.parse(body) as CreateCalendarEventBody;
		} catch {
			this.sendJson(res, 400, { error: 'Invalid JSON body' });
			return;
		}
		if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
			this.sendJson(res, 400, { error: 'Missing "title" string field' });
			return;
		}
		if (typeof parsed.start !== 'string' || !parsed.start) {
			this.sendJson(res, 400, { error: 'Missing "start" string field' });
			return;
		}
		const title = parsed.title.trim();
		const start = parsed.start;
		// Default to a 1-hour event when no end is given.
		const end = typeof parsed.end === 'string' && parsed.end
			? parsed.end
			: new Date(new Date(parsed.start).getTime() + 60 * 60 * 1000).toISOString();
		const calendar = typeof parsed.calendar === 'string' ? parsed.calendar : undefined;
		await this.withCalendarErrors(res, async () => {
			await createCalendarEventInStore(calendar || '', title, start, end);
			this.sendJson(res, 201, { ok: true });
		});
	}

	private async updateCalendarEvent(req: IncomingMessage, res: ServerResponse, id: string) {
		if (!id) {
			this.sendJson(res, 400, { error: 'Missing event id' });
			return;
		}
		const body = await this.readBody(req);
		let parsed: UpdateCalendarEventBody;
		try {
			parsed = JSON.parse(body) as UpdateCalendarEventBody;
		} catch {
			this.sendJson(res, 400, { error: 'Invalid JSON body' });
			return;
		}
		if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
			this.sendJson(res, 400, { error: 'Missing "title" string field' });
			return;
		}
		if (typeof parsed.start !== 'string' || !parsed.start) {
			this.sendJson(res, 400, { error: 'Missing "start" string field' });
			return;
		}
		const eventTitle = parsed.title.trim();
		const eventStart = parsed.start;
		const eventEnd = typeof parsed.end === 'string' && parsed.end
			? parsed.end
			: new Date(new Date(parsed.start).getTime() + 60 * 60 * 1000).toISOString();
		await this.withCalendarErrors(res, async () => {
			await updateCalendarEventInStore(id, eventTitle, eventStart, eventEnd);
			this.sendJson(res, 200, { ok: true });
		});
	}

	private async deleteCalendarEvent(res: ServerResponse, id: string) {
		if (!id) {
			this.sendJson(res, 400, { error: 'Missing event id' });
			return;
		}
		await this.withCalendarErrors(res, async () => {
			await deleteCalendarEventInStore(id);
			this.sendJson(res, 200, { ok: true });
		});
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
				await this.readDailyNotesConfig(res);
				return;
			}

			if (method === 'GET' && path === '/api/journals') {
				await this.listJournals(res, url);
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

			if (method === 'GET' && path === '/api/reminders') {
				if (!this.settings.enableReminders) {
					this.sendJson(res, 404, { error: 'Reminders API is disabled (enable it in Note API settings)' });
					return;
				}
				await this.listReminders(res, url);
				return;
			}

			if (method === 'GET' && path === '/api/calendar') {
				if (!this.settings.enableReminders) {
					this.sendJson(res, 404, { error: 'Calendar API is disabled (enable "Reminders API" in Note API settings)' });
					return;
				}
				await this.listCalendarEvents(res, url);
				return;
			}

			if (method === 'POST' && path === '/api/calendar') {
				if (!this.settings.enableReminders) {
					this.sendJson(res, 404, { error: 'Calendar API is disabled (enable "Reminders API" in Note API settings)' });
					return;
				}
				await this.createCalendarEvent(req, res);
				return;
			}

			const calendarPrefix = '/api/calendar/';
			if (path.startsWith(calendarPrefix)) {
				if (!this.settings.enableReminders) {
					this.sendJson(res, 404, { error: 'Calendar API is disabled (enable "Reminders API" in Note API settings)' });
					return;
				}
				const eventId = decodeURIComponent(path.slice(calendarPrefix.length));
				if (method === 'PUT') {
					await this.updateCalendarEvent(req, res, eventId);
					return;
				}
				if (method === 'DELETE') {
					await this.deleteCalendarEvent(res, eventId);
					return;
				}
				this.sendJson(res, 405, { error: 'Method not allowed' });
				return;
			}

			if (method === 'POST' && path === '/api/reminders') {
				if (!this.settings.enableReminders) {
					this.sendJson(res, 404, { error: 'Reminders API is disabled (enable it in Note API settings)' });
					return;
				}
				await this.createReminder(req, res);
				return;
			}

			const reminderPrefix = '/api/reminders/';
			if (path.startsWith(reminderPrefix)) {
				if (!this.settings.enableReminders) {
					this.sendJson(res, 404, { error: 'Reminders API is disabled (enable it in Note API settings)' });
					return;
				}
				const reminderId = decodeURIComponent(path.slice(reminderPrefix.length));
				if (method === 'PUT') {
					await this.updateReminder(req, res, reminderId);
					return;
				}
				if (method === 'DELETE') {
					await this.deleteReminder(res, reminderId);
					return;
				}
				this.sendJson(res, 405, { error: 'Method not allowed' });
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
		const offsetParam = Number.parseInt(url.searchParams.get('offset') ?? '', 10);
		const offset = Number.isInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;
		const notes: NoteSummary[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (folder && !file.path.startsWith(folder)) {
				continue;
			}
			const pathMatches = !query
				|| file.path.toLowerCase().includes(query)
				|| file.basename.toLowerCase().includes(query);
			let content: string | undefined;
			if (query && !pathMatches) {
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
				const body = content ?? (await this.app.vault.cachedRead(file));
				// Frontmatter tags live in the metadata cache, not the raw body,
				// so a plain-text search would miss them. Prepend them so
				// keyword filtering sees the same tags as /api/tags.
				const cache = this.app.metadataCache.getFileCache(file);
				const tags = cache ? getAllTags(cache) : null;
				summary.content = tags && tags.length ? `${tags.join(' ')}\n${body}` : body;
			}
			notes.push(summary);
		}
		notes.sort((a, b) => b.mtime - a.mtime);
		const total = notes.length;
		const page = offset ? notes.slice(offset, limit ? offset + limit : undefined) : limit ? notes.slice(0, limit) : notes;
		this.sendJson(res, 200, { notes: page, total });
	}

	private async readDailyNotesConfigValues(): Promise<DailyNotesConfig> {
		const config: DailyNotesConfig = { folder: 'journals', format: 'YYYY-MM-DD' };
		try {
			const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/daily-notes.json`);
			const parsed = JSON.parse(raw) as { folder?: unknown; format?: unknown };
			if (typeof parsed.folder === 'string' && parsed.folder) config.folder = parsed.folder;
			if (typeof parsed.format === 'string' && parsed.format) config.format = parsed.format;
		} catch {
			// keep defaults
		}
		return config;
	}

	private async readDailyNotesConfig(res: ServerResponse) {
		const config = await this.readDailyNotesConfigValues();
		this.sendJson(res, 200, config);
	}

	// Journal entries live in the configured daily-notes folder, but that
	// folder can also hold other files — a note only counts as a journal when
	// its basename parses as a date in the configured format. Sorted by that
	// date desc (not mtime) and paged server-side.
	private async listJournals(res: ServerResponse, url: URL) {
		const config = await this.readDailyNotesConfigValues();
		const folder = config.folder.replace(/\/+$/, '');
		const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
		const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 50;
		const offsetParam = Number.parseInt(url.searchParams.get('offset') ?? '', 10);
		const offset = Number.isInteger(offsetParam) && offsetParam > 0 ? offsetParam : 0;
		const journals: { path: string; name: string; mtime: number; size: number; date: number }[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (folder && !file.path.startsWith(`${folder}/`)) {
				continue;
			}
			// Assert a structural type: in some lint environments obsidian's
			// moment re-export resolves to an error/any type, which trips
			// @typescript-eslint/no-unsafe-* on the calls below.
			const date = moment(file.basename, config.format, true) as { isValid(): boolean; valueOf(): number };
			if (!date.isValid()) {
				continue;
			}
			journals.push({
				path: file.path,
				name: file.basename,
				mtime: file.stat.mtime,
				size: file.stat.size,
				date: date.valueOf(),
			});
		}
		journals.sort((a, b) => b.date - a.date || (a.path < b.path ? -1 : 1));
		const total = journals.length;
		const page = journals.slice(offset, offset + limit).map(({ date, ...summary }) => summary);
		this.sendJson(res, 200, { notes: page, total, folder, format: config.format });
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				cls: 'note-api-settings',
				items: [
					{
						name: 'Server status',
						render: (setting) => {
							setting
								.setDesc(
									this.plugin.isRunning()
										? `Running on http://127.0.0.1:${this.plugin.settings.port}`
										: 'Stopped'
								)
								.addButton((button) =>
									button
										.setButtonText(this.plugin.isRunning() ? 'Stop' : 'Start')
										.onClick(() => {
											void this.plugin.toggleServer().then(() => this.update());
										})
								);
						},
					},
					{
						name: 'Port',
						desc: 'Localhost port for the HTTP API. Restart required.',
						render: (setting) => {
							setting
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
										this.update();
									})
								);
						},
					},
					{
						name: 'API key',
						desc: 'Required for every request: Authorization: Bearer <key>',
						render: (setting) => {
							setting
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
											this.update();
										})
								);
						},
					},
					{
						name: 'Start on launch',
						desc: 'Automatically start the HTTP server when the vault opens.',
						render: (setting) => {
							setting.addToggle((toggle) =>
								toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
									this.plugin.settings.autoStart = value;
									await this.plugin.saveSettings();
								})
							);
						},
					},
					{
						name: 'Reminders API (macOS)',
					desc: 'Expose /api/reminders and /api/calendar endpoints that read and write macOS Reminders and Calendar via EventKit. Off by default; macOS only.',
						render: (setting) => {
							setting.addToggle((toggle) =>
								toggle.setValue(this.plugin.settings.enableReminders).onChange(async (value) => {
									this.plugin.settings.enableReminders = value;
									await this.plugin.saveSettings();
								})
							);
						},
					},
					{
						name: 'note-tab 浏览器扩展',
						desc: '新标签页查看/编辑本仓库笔记。下载 zip 解压后，在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」。后续会发布到 Chrome 应用商店。',
						render: (setting) => {
							setting.addButton((button) =>
								button.setButtonText('下载扩展').onClick(() => {
									window.open('https://api.fengshuzi.com/dl/1c407c0ead81a88f/note-tab-1.0.1.zip');
								})
							);
						},
					},
					{
						name: 'Donate',
						searchable: false,
						render: (setting, group) => {
							setting.settingEl.addClass('note-api-hidden');
							const donateSection = group.listEl.createDiv({ cls: 'note-api-donate' });
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
						},
					},
				],
			},
		];
	}
}
