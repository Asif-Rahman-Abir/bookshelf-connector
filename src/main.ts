import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
	requestUrl,
	stringifyYaml,
} from 'obsidian';

type FM = Record<string, any>;

const AUDIBLE_GROUPS =
	'contributors,product_desc,product_attrs,product_extended_attrs,media,rating,series,category_ladders';

interface Settings {
	booksFolder: string;
	coversFolder: string;
	downloadCovers: boolean;
	audibleMarketplace: string;
	inferChapters: boolean;
	journeyHeading: string;
}

const DEFAULT_SETTINGS: Settings = {
	booksFolder: 'Books',
	coversFolder: 'Books/covers',
	downloadCovers: true,
	audibleMarketplace: 'com',
	inferChapters: true,
	journeyHeading: 'Reading Journey',
};

const pad = (n: number) => String(n).padStart(2, '0');
const isoToday = () => new Date().toISOString().slice(0, 10);
const hmm = (minutes: number) => `${Math.floor(minutes / 60)}:${pad(Math.round(minutes % 60))}`;
const safeName = (s: string) =>
	s.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled';
const stripHtml = (s?: string) => s?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const names = (arr?: { name?: string }[]): string[] =>
	(arr ?? []).map(x => x.name).filter((x): x is string => !!x);

function extractAsin(input: string): string | undefined {
	const s = input.trim();
	return (
		s.match(/\/(?:pd|dp)\/(?:[^/]+\/)?([A-Z0-9]{10})/i)?.[1] ??
		s.match(/[?&]asin=([A-Z0-9]{10})/i)?.[1] ??
		(/^[A-Z0-9]{10}$/i.test(s) ? s : undefined)
	);
}

function meta(doc: Document, key: string): string | undefined {
	return doc
		.querySelector(`meta[property="${key}"], meta[name="${key}"]`)
		?.getAttribute('content')
		?.trim();
}

function declaredCount(doc: Document, html: string): number | undefined {
	const cut = /You May Also Like|Recommended For You|Comments|Reviews|Leave a Reply/i;
	const bodyText = doc.body?.textContent ?? '';
	const sources = [
		bodyText.split(cut)[0],
		html.split(cut)[0].replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '),
	];
	const counts: number[] = [];
	for (const src of sources) {
		for (const re of [/(\d[\d,]*)\s+chapters?\b/gi, /chapters?\s*[:\(]\s*(\d[\d,]*)/gi]) {
			let m: RegExpExecArray | null;
			while ((m = re.exec(src))) {
				const value = m[1];
				if (value) {
					const n = Number(value.replace(/,/g, ''));
					if (Number.isFinite(n) && n > 0 && n < 50000) counts.push(n);
				}
			}
		}
	}
	return counts.length ? Math.max(...counts) : undefined;
}

function discoverChapters(html: string, pageUrl: string, slug: string) {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const found = new Set<number>();
	const links = doc.querySelectorAll('a[href]');
	for (let i = 0; i < links.length; i++) {
		const a = links[i];
		const href = a.getAttribute('href');
		if (!href) continue;
		try {
			const u = new URL(href, pageUrl);
			const parts = u.pathname.split('/').filter(Boolean);
			if (parts.length !== 3 || parts[0] !== 'novel' || parts[1] !== slug) continue;
			const m = parts[2].match(/^chapter-(\d+)$/);
			if (m) found.add(Number(m[1]));
		} catch { /* not a URL */ }
	}
	const normalized = html.replace(/\\\//g, '/').replace(/&amp;/g, '&');
	const re = new RegExp(`/novel/${escapeRe(slug)}/chapter-(\\d+)`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(normalized))) {
		const value = m[1];
		if (value) found.add(Number(value));
	}
	return { doc, found };
}

export default class BookshelfConnector extends Plugin {
	settings!: Settings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'search-audible',
			name: 'Search Audible by title',
			callback: () => new AudibleSearchModal(this.app, this).open(),
		});

		this.addCommand({
			id: 'import-audible',
			name: 'Import audiobook from Audible URL or ASIN',
			callback: () => new TextModal(this.app, 'Import audiobook', 'Audible URL or ASIN',
				'https://www.audible.com/pd/… or B0XXXXXXXX',
				v => this.run(() => this.importAudiobook(v))).open(),
		});

		this.addCommand({
			id: 'import-novelphoenix',
			name: 'Import web novel from NovelPhoenix URL',
			callback: () => new TextModal(this.app, 'Import web novel', 'NovelPhoenix URL',
				'https://novelphoenix.com/novel/…',
				v => this.run(() => this.importNovel(v))).open(),
		});

		this.addCommand({
			id: 'refresh-novel',
			name: 'Refresh chapter count for current novel',
			callback: () => this.run(() => this.refreshNovel()),
		});

		this.addCommand({
			id: 'migrate-library',
			name: 'Migrate Library-format notes to Bookshelf',
			callback: () => this.run(() => this.migrateLibraryNotes()),
		});

		this.addSettingTab(new ConnectorSettings(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	async run(fn: () => Promise<void>) {
		try { await fn(); }
		catch (e) {
			new Notice(`Failed: ${e instanceof Error ? e.message : String(e)}`);
			console.error('[BookshelfConnector]', e);
		}
	}

	private async downloadCover(url: string | undefined, title: string): Promise<string | undefined> {
		if (!this.settings.downloadCovers || !url) return undefined;
		try {
			const folder = normalizePath(this.settings.coversFolder);
			await this.app.vault.createFolder(folder).catch(() => {});
			const parts = url.split('?')[0]?.split('.') ?? [];
			const ext = (parts[parts.length - 1] ?? 'jpg')
				.replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'jpg';
			const path = normalizePath(`${folder}/${safeName(title)}.${ext}`);
			if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return path;
			const res = await requestUrl({ url, throw: false });
			if (res.status !== 200) return undefined;
			await this.app.vault.createBinary(path, res.arrayBuffer);
			return path;
		} catch (e) {
			console.warn('[BookshelfConnector] cover failed', e);
			return undefined;
		}
	}

	private coverValue(path: string | undefined, url: string | undefined): string | undefined {
		if (path) return `[[${path}]]`;
		return url;
	}

	private async writeBook(
		title: string,
		props: FM,
		synopsis: string,
		match: (fm: FM) => boolean,
	) {
		const existing = this.findBook(match);
		if (existing) {
			await this.app.fileManager.processFrontMatter(existing, fm => {
				for (const [k, v] of Object.entries(props)) {
					if (v === undefined || v === null || v === '') continue;
					if ((k === 'rating' || k === 'comment') && fm[k] != null) continue;
					fm[k] = v;
				}
			});
			await this.ensureJourney(existing);
			new Notice(`Updated: ${title}`);
			await this.app.workspace.getLeaf(true).openFile(existing);
			return;
		}

		const folder = normalizePath(this.settings.booksFolder);
		await this.app.vault.createFolder(folder).catch(() => {});
		const path = normalizePath(`${folder}/${safeName(title)}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			throw new Error(`A note already exists at ${path}`);
		}

		const fm: FM = { title };
		for (const [k, v] of Object.entries(props)) {
			if (v !== undefined && v !== null && v !== '') fm[k] = v;
		}

		const body =
			`## ${this.settings.journeyHeading}\n\n` +
			`## Synopsis\n\n${synopsis || '_None found._'}\n\n` +
			`## Notes\n\n`;

		const file = await this.app.vault.create(path, `---\n${stringifyYaml(fm)}---\n\n${body}`);
		new Notice(`Added: ${title}`);
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	private findBook(match: (fm: FM) => boolean): TFile | undefined {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as FM | undefined;
			if (fm && match(fm)) return file;
		}
		return undefined;
	}

	private async ensureJourney(file: TFile) {
		const heading = `## ${this.settings.journeyHeading}`;
		const content = await this.app.vault.read(file);
		if (content.includes(heading)) return;
		const parts = content.split(/^---\s*$/m);
		if (parts.length >= 3) {
			const rebuilt = `---${parts[1]}---\n\n${heading}\n\n${parts.slice(2).join('---').trimStart()}`;
			await this.app.vault.modify(file, rebuilt);
		} else {
			await this.app.vault.modify(file, `${content}\n\n${heading}\n\n`);
		}
	}

	private audibleBase(): string {
		return `https://api.audible.${this.settings.audibleMarketplace || 'com'}`;
	}

	async audibleSearch(query: string): Promise<FM[]> {
		const url = `${this.audibleBase()}/1.0/catalog/products?keywords=${encodeURIComponent(query)}` +
			`&num_results=25&response_groups=${AUDIBLE_GROUPS}&image_sizes=500`;
		const res = await requestUrl({ url, throw: false });
		if (res.status !== 200) {
			throw new Error(`Audible HTTP ${res.status} (marketplace: ${this.settings.audibleMarketplace})`);
		}
		return res.json?.products ?? [];
	}

	async importAudiobook(input: string) {
		const asin = extractAsin(input);
		if (!asin) throw new Error('Could not find an ASIN in that input');
		new Notice('Fetching from Audible…');
		const url = `${this.audibleBase()}/1.0/catalog/products/${asin}` +
			`?response_groups=${AUDIBLE_GROUPS}&image_sizes=500,1215`;
		const res = await requestUrl({ url, throw: false });
		if (res.status !== 200) throw new Error(`Audible HTTP ${res.status}`);
		const p = res.json?.product;
		if (!p) throw new Error(`No Audible product for ${asin}`);
		await this.writeAudiobook(p);
	}

	async writeAudiobook(p: FM) {
		const asin = String(p.asin ?? '');
		if (!asin) throw new Error('Audible product has no ASIN');
		const title = String(p.title ?? asin);
		const minutes = p.runtime_length_min ? Math.round(Number(p.runtime_length_min)) : 0;

		const images: Record<string, string> = p.product_images ?? {};
		const imageKeys = Object.keys(images).sort((a, b) => Number(b) - Number(a));
		const coverUrl = images['500'] ?? (imageKeys[0] ? images[imageKeys[0]] : undefined);
		const coverPath = await this.downloadCover(coverUrl, title);

		const series = Array.isArray(p.series) && p.series.length
			? [...p.series].sort((a: FM, b: FM) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0))[0]
			: undefined;

		const genres = [...new Set<string>(
			(p.category_ladders ?? []).flatMap((l: FM) => (l.ladder ?? []).map((c: FM) => c.name)),
		)].slice(0, 6);

		const narrators = names(p.narrators);
		const audibleUrl = `https://www.audible.${this.settings.audibleMarketplace}/pd/${asin}`;

		const props: FM = {
			author: names(p.authors),
			cover: this.coverValue(coverPath, coverUrl),
			genre: genres,
			links: [audibleUrl],
			series: series?.title ? String(series.title) : undefined,
			'position-in-series': series?.sequence != null ? Number(series.sequence) : undefined,
			duration: minutes > 0 ? hmm(minutes) : undefined,
			narrator: narrators.length ? narrators : undefined,
			'audible-asin': asin,
		};

		const synopsis = stripHtml(p.publisher_summary) || stripHtml(p.merchandising_summary);
		await this.writeBook(title, props, synopsis, fm => String(fm['audible-asin'] ?? '') === asin);
	}

	private async scrapeNovel(input: string) {
		let url: URL;
		try { url = new URL(input.trim()); }
		catch { throw new Error('Enter a full NovelPhoenix URL'); }
		if (!/(^|\.)novelphoenix\.com$/.test(url.hostname)) {
			throw new Error('Expected a novelphoenix.com URL');
		}
		const slug = url.pathname.match(/^\/novel\/([^/]+)/)?.[1];
		if (!slug) throw new Error('Expected a URL like novelphoenix.com/novel/<slug>');
		url.hash = ''; url.search = '';
		const pageUrl = url.toString().replace(/\/$/, '');

		const res = await requestUrl({
			url: pageUrl, throw: false,
			headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
		});
		if (res.status !== 200) throw new Error(`NovelPhoenix returned HTTP ${res.status}`);

		const { doc, found } = discoverChapters(res.text, pageUrl, slug);
		const total = Math.max(declaredCount(doc, res.text) ?? 0, found.size);
		if (total <= 0) throw new Error('Could not determine chapter count');

		const genreLinks = doc.querySelectorAll('a[href*="/genre-"]');
		const genres: string[] = [];
		for (let i = 0; i < genreLinks.length; i++) {
			const text = genreLinks[i].textContent?.trim();
			if (text && !genres.includes(text)) genres.push(text);
		}

		return {
			slug, pageUrl, total,
			discovered: found.size,
			inferred: this.settings.inferChapters && found.size < total,
			title: meta(doc, 'og:title')?.replace(/\s*[-|]\s*Novel Phoenix.*$/i, '').trim()
				?? doc.querySelector('h1')?.textContent?.trim() ?? slug,
			author: meta(doc, 'author')
				?? doc.querySelector('a[href*="/author/"]')?.textContent?.trim()
				?? doc.querySelector('[itemprop="author"]')?.textContent?.trim(),
			genres: genres.slice(0, 8),
			coverUrl: meta(doc, 'og:image'),
			synopsis: stripHtml(meta(doc, 'og:description')),
		};
	}

	async importNovel(input: string) {
		new Notice('Fetching novel…');
		const n = await this.scrapeNovel(input);
		const coverPath = await this.downloadCover(n.coverUrl, n.title);

		const props: FM = {
			author: n.author ? [n.author] : undefined,
			cover: this.coverValue(coverPath, n.coverUrl),
			genre: n.genres,
			pages: n.total,
			links: [n.pageUrl],
			tags: ['webnovel'],
			'novelphoenix-slug': n.slug,
			'novelphoenix-inferred': n.inferred ? true : undefined,
		};

		await this.writeBook(n.title, props, n.synopsis,
			fm => String(fm['novelphoenix-slug'] ?? '') === n.slug);

		new Notice(n.inferred
			? `${n.total} chapters (${n.discovered} link found, rest inferred)`
			: `${n.total} chapters`);
	}

	async refreshNovel() {
		const file = this.app.workspace.getActiveFile();
		if (!file) throw new Error('Open a novel note first');
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as FM | undefined;
		const slug = String(fm?.['novelphoenix-slug'] ?? '');
		if (!slug) throw new Error('This note has no novelphoenix-slug');
		const n = await this.scrapeNovel(`https://novelphoenix.com/novel/${slug}`);
		await this.app.fileManager.processFrontMatter(file, f => {
			f.pages = n.total;
			if (n.inferred) f['novelphoenix-inferred'] = true;
			else delete f['novelphoenix-inferred'];
		});
		new Notice(`Chapter count: ${n.total}`);
	}

	async migrateLibraryNotes() {
		const targets = this.app.vault.getMarkdownFiles().filter(f => {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as FM | undefined;
			return fm?.Name != null && fm?.Type != null && fm?.Source != null;
		});
		if (!targets.length) { new Notice('No Library-format notes found'); return; }

		const folder = normalizePath(this.settings.booksFolder);
		await this.app.vault.createFolder(folder).catch(() => {});
		let moved = 0;

		for (const file of targets) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as FM | undefined;
			if (!fm) continue;

			const title = String(fm.Name);
			const creators = Array.isArray(fm.Creator) ? fm.Creator : fm.Creator ? [fm.Creator] : [];
			const genres = Array.isArray(fm.Genre) ? fm.Genre : fm.Genre ? [fm.Genre] : [];
			const isAudio = String(fm.Format ?? '').toLowerCase().includes('audiobook');
			const runtimeMin = Number(fm.Runtime ?? 0);
			const doneMatch = String(fm.Progress ?? '').match(/^(\d+)\s*\/\s*(\d+)$/);
			const done = doneMatch ? Number(doneMatch[1]) : 0;
			const total = doneMatch ? Number(doneMatch[2]) : 0;

			const links: string[] = [];
			if (fm['Audible URL']) links.push(String(fm['Audible URL']));
			if (fm['NovelPhoenix URL']) links.push(String(fm['NovelPhoenix URL']));

			const props: FM = {
				author: creators.length ? creators : undefined,
				genre: genres.length ? genres : undefined,
				cover: typeof fm.Cover === 'string'
					? (fm.Cover.startsWith('[[') || /^https?:/.test(fm.Cover) ? fm.Cover : `[[${fm.Cover}]]`)
					: undefined,
				links: links.length ? links : undefined,
				rating: fm['My Rating'] != null ? Number(fm['My Rating']) : undefined,
				series: fm['Audible Series'] ? String(fm['Audible Series']) : undefined,
				'position-in-series': fm['Audible Series Index'] != null
					? Number(fm['Audible Series Index']) : undefined,
				duration: isAudio && runtimeMin > 0 ? hmm(runtimeMin) : undefined,
				pages: !isAudio && total > 0 ? total : undefined,
				narrator: Array.isArray(fm.Narrator) ? fm.Narrator
					: fm.Narrator ? [fm.Narrator] : undefined,
				'audible-asin': fm['Audible ASIN'] ? String(fm['Audible ASIN']) : undefined,
				'novelphoenix-slug': fm.Source === 'novelphoenix' ? String(fm['Source ID'] ?? '') : undefined,
			};

			await this.app.fileManager.processFrontMatter(file, f => {
				for (const k of ['Type', 'Name', 'Creator', 'Genre', 'Cover', 'Format', 'Runtime',
					'Runtime Estimated', 'Progress', 'Chapters', 'My Rating', 'Complete', 'Date',
					'Source', 'Source ID', 'Narrator', 'Audible URL', 'Audible ASIN', 'Audible Series',
					'Audible Series Index', 'Audible Rating', 'NovelPhoenix URL', 'NovelPhoenix Inferred']) {
					delete f[k];
				}
				f.title = title;
				for (const [k, v] of Object.entries(props)) {
					if (v !== undefined && v !== null && v !== '') f[k] = v;
				}
			});

			const heading = `## ${this.settings.journeyHeading}`;
			let content = await this.app.vault.read(file);
			if (!content.includes(heading) && (done > 0 || total > 0)) {
				const unit = isAudio ? hmm(done) : String(done);
				const lines = [`- ${isoToday()}: Started`];
				if (done > 0) lines.push(`- ${isoToday()}: ${unit}`);
				if (total > 0 && done >= total) lines.push(`- ${isoToday()}: Finished`);
				content = content.replace(/^(---[\s\S]*?---\s*)/, `$1\n${heading}\n\n${lines.join('\n')}\n\n`);
				await this.app.vault.modify(file, content);
			} else {
				await this.ensureJourney(file);
			}

			const newPath = normalizePath(`${folder}/${file.name}`);
			if (file.path !== newPath && !this.app.vault.getAbstractFileByPath(newPath)) {
				await this.app.fileManager.renameFile(file, newPath);
			}
			moved++;
		}

		new Notice(`Migrated ${moved} note${moved === 1 ? '' : 's'} to Bookshelf format`);
	}
}

class ConnectorSettings extends PluginSettingTab {
	constructor(app: App, private plugin: BookshelfConnector) { super(app, plugin); }

	display() {
		this.containerEl.empty();
		this.containerEl.createEl('h2', { text: 'Bookshelf Connector' });
		this.containerEl.createEl('p', {
			text: 'Books folder must match Bookshelf\'s own Books folder setting. Property names below use Bookshelf\'s defaults — if you renamed them in Bookshelf, tell me and I\'ll make them configurable.',
			cls: 'setting-item-description',
		});

		new Setting(this.containerEl).setName('Books folder')
			.setDesc('Must match Bookshelf → Books folder.')
			.addText(t => t.setValue(this.plugin.settings.booksFolder).onChange(async v => {
				this.plugin.settings.booksFolder = v.trim() || DEFAULT_SETTINGS.booksFolder;
				await this.plugin.saveSettings();
			}));

		new Setting(this.containerEl).setName('Covers folder')
			.addText(t => t.setValue(this.plugin.settings.coversFolder).onChange(async v => {
				this.plugin.settings.coversFolder = v.trim() || DEFAULT_SETTINGS.coversFolder;
				await this.plugin.saveSettings();
			}));

		new Setting(this.containerEl).setName('Reading journey heading')
			.setDesc('Must match Bookshelf\'s heading for progress entries in book notes.')
			.addText(t => t.setValue(this.plugin.settings.journeyHeading).onChange(async v => {
				this.plugin.settings.journeyHeading = v.trim() || DEFAULT_SETTINGS.journeyHeading;
				await this.plugin.saveSettings();
			}));

		new Setting(this.containerEl).setName('Audible marketplace')
			.setDesc('com, co.uk, de, fr, it, es, ca, com.au, in, jp')
			.addText(t => t.setValue(this.plugin.settings.audibleMarketplace).onChange(async v => {
				this.plugin.settings.audibleMarketplace = v.trim() || 'com';
				await this.plugin.saveSettings();
			}));

		new Setting(this.containerEl).setName('Download covers into the vault')
			.addToggle(t => t.setValue(this.plugin.settings.downloadCovers).onChange(async v => {
				this.plugin.settings.downloadCovers = v;
				await this.plugin.saveSettings();
			}));

		new Setting(this.containerEl).setName('Infer NovelPhoenix chapter links')
			.addToggle(t => t.setValue(this.plugin.settings.inferChapters).onChange(async v => {
				this.plugin.settings.inferChapters = v;
				await this.plugin.saveSettings();
			}));
	}
}

class TextModal extends Modal {
	private value = '';
	constructor(app: App, private heading: string, private label: string,
		private placeholder: string, private onSubmit: (v: string) => void) { super(app); }

	onOpen() {
		this.contentEl.empty();
		this.contentEl.createEl('h3', { text: this.heading });
		let input: HTMLInputElement | null = null;
		new Setting(this.contentEl).setName(this.label).addText(t => {
			input = t.inputEl;
			t.setPlaceholder(this.placeholder).onChange(v => { this.value = v; });
		});
		new Setting(this.contentEl).addButton(b =>
			b.setButtonText('Import').setCta().onClick(() => this.submit()));
		this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
		});
		window.setTimeout(() => input?.focus(), 0);
	}
	private submit() { const v = this.value.trim(); this.close(); if (v) this.onSubmit(v); }
	onClose() { this.contentEl.empty(); }
}

class AudibleSearchModal extends Modal {
	private query = '';
	private results!: HTMLElement;
	constructor(app: App, private plugin: BookshelfConnector) { super(app); }

	onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass('connector-search');
		this.contentEl.createEl('h3', { text: 'Search Audible' });
		let input: HTMLInputElement | null = null;
		new Setting(this.contentEl).setName('Title (add the author to narrow it)').addText(t => {
			input = t.inputEl;
			t.setPlaceholder('Dungeon Crawler Carl Matt Dinniman').onChange(v => { this.query = v; });
		});
		new Setting(this.contentEl).addButton(b =>
			b.setButtonText('Search').setCta().onClick(() => void this.search()));
		this.results = this.contentEl.createDiv({ cls: 'connector-results' });
		this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); void this.search(); }
		});
		window.setTimeout(() => input?.focus(), 0);
	}

	private async search() {
		const q = this.query.trim();
		if (!q) return;
		this.results.empty();
		this.results.createDiv({ cls: 'connector-status', text: 'Searching…' });
		try {
			const products = await this.plugin.audibleSearch(q);
			this.results.empty();
			if (!products.length) {
				this.results.createDiv({ cls: 'connector-status',
					text: 'Nothing found. Try another marketplace in settings, or fewer words.' });
				return;
			}
			for (const p of products) {
				const mins = p.runtime_length_min ? Math.round(Number(p.runtime_length_min)) : 0;
				const row = this.results.createDiv({ cls: 'connector-row' });
				row.createDiv({ cls: 'connector-row-title', text: String(p.title ?? p.asin) });
				row.createDiv({ cls: 'connector-row-meta', text: [
					names(p.authors).join(', '),
					mins ? hmm(mins) : 'no runtime',
					names(p.narrators)[0] ? `read by ${names(p.narrators)[0]}` : '',
				].filter(Boolean).join(' · ') });
				row.addEventListener('click', () => {
					this.close();
					void this.plugin.run(() => this.plugin.writeAudiobook(p));
				});
			}
		} catch (e) {
			this.results.empty();
			this.results.createDiv({ cls: 'connector-status',
				text: e instanceof Error ? e.message : String(e) });
		}
	}
	onClose() { this.contentEl.empty(); }
}