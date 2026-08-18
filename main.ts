// TranscriptExporter Sync - Obsidian companion plugin
// Copyright 2026 TranscriptExporter. Released under the MIT License.
//
// Runs a localhost-only HTTP server inside Obsidian so the TranscriptExporter
// Chrome extensions can deliver meeting notes straight into the vault. This
// is what makes true always-on hourly sync possible: Chrome's File System
// Access grants never reach extension service workers, but a plain fetch to
// 127.0.0.1 works from anywhere in the extension, no user gesture needed.
//
// Security posture:
// - The server binds 127.0.0.1 only. Nothing on the network can reach it.
// - Every write requires a Bearer pairing key, generated on first run and
//   compared in constant time. The user copies it into the extension once.
// - Only .md files are accepted, paths are sanitized segment by segment, and
//   traversal (.., absolute paths) is rejected outright.
// - Skip-if-exists write policy: a file already in the vault is NEVER
//   rewritten. User edits are sacred. Same policy as the extensions' direct
//   vault writes.

import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    normalizePath
} from 'obsidian';
import * as http from 'http';
import type { Socket } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';

const DEFAULT_PORT = 27125; // 27123/27124 belong to the Local REST API plugin
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;

interface SyncSettings {
    serverEnabled: boolean;
    port: number;
    apiKey: string;
    notesReceived: number;
}

const DEFAULT_SETTINGS: SyncSettings = {
    serverEnabled: true,
    port: DEFAULT_PORT,
    apiKey: '',
    notesReceived: 0
};

type ServerState =
    | { kind: 'stopped' }
    | { kind: 'listening'; port: number }
    | { kind: 'error'; message: string };

export default class TranscriptExporterSyncPlugin extends Plugin {
    settings: SyncSettings = { ...DEFAULT_SETTINGS };
    private server: http.Server | null = null;
    private sockets = new Set<Socket>();
    private serverState: ServerState = { kind: 'stopped' };
    private settingsTab: SyncSettingTab | null = null;

    async onload() {
        await this.loadSettings();

        if (!this.settings.apiKey) {
            this.settings.apiKey = randomBytes(24).toString('hex');
            await this.saveSettings();
        }

        this.settingsTab = new SyncSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        if (this.settings.serverEnabled) {
            // Defer to layout-ready so a slow vault open never blocks on us.
            this.app.workspace.onLayoutReady(() => this.startServer());
        }
    }

    onunload() {
        this.stopServer();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getServerState(): ServerState {
        return this.serverState;
    }

    // ------------------------------------------------------------------
    // Server lifecycle
    // ------------------------------------------------------------------

    startServer() {
        this.stopServer();

        const port = this.settings.port;
        const server = http.createServer((req, res) => {
            this.handleRequest(req, res).catch((e) => {
                this.sendJson(res, 500, { ok: false, error: 'internal', message: String(e && e.message || e) });
            });
        });

        // Track sockets so stopServer() can close immediately instead of
        // waiting out keep-alive connections from the extension.
        server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });

        server.on('error', (e: NodeJS.ErrnoException) => {
            const message = e.code === 'EADDRINUSE'
                ? `Port ${port} is already in use. Pick a different port in the plugin settings.`
                : `Server error: ${e.message}`;
            this.serverState = { kind: 'error', message };
            this.server = null;
            new Notice('TranscriptExporter Sync: ' + message);
            this.refreshSettingsTab();
        });

        server.listen(port, '127.0.0.1', () => {
            this.serverState = { kind: 'listening', port };
            console.log(`TranscriptExporter Sync listening on 127.0.0.1:${port}`);
            this.refreshSettingsTab();
        });

        this.server = server;
    }

    stopServer() {
        if (this.server) {
            try { this.server.close(); } catch (_) { /* already closing */ }
            this.server = null;
        }
        for (const socket of this.sockets) {
            try { socket.destroy(); } catch (_) { /* already gone */ }
        }
        this.sockets.clear();
        this.serverState = { kind: 'stopped' };
        this.refreshSettingsTab();
    }

    async restartServer() {
        if (this.settings.serverEnabled) {
            this.startServer();
        } else {
            this.stopServer();
        }
    }

    private refreshSettingsTab() {
        if (this.settingsTab && this.settingsTab.isVisible()) {
            this.settingsTab.renderStatus();
        }
    }

    // ------------------------------------------------------------------
    // Request handling
    // ------------------------------------------------------------------

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // CORS: the callers are chrome-extension:// origins, which cannot be
        // enumerated ahead of time (ids differ per store listing). The Bearer
        // key is the actual gate; the origin header is not a security
        // boundary on a localhost server anyway.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = (req.url || '/').split('?')[0];

        // Unauthenticated liveness probe: lets the extension tell "plugin not
        // running" apart from "wrong key" without leaking vault details.
        if (req.method === 'GET' && url === '/ping') {
            this.sendJson(res, 200, {
                ok: true,
                app: 'transcriptexporter-sync',
                version: this.manifest.version
            });
            return;
        }

        if (!this.isAuthorized(req)) {
            this.sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Missing or invalid pairing key' });
            return;
        }

        if (req.method === 'GET' && url === '/status') {
            this.sendJson(res, 200, {
                ok: true,
                app: 'transcriptexporter-sync',
                version: this.manifest.version,
                vault: this.app.vault.getName(),
                notesReceived: this.settings.notesReceived
            });
            return;
        }

        if (req.method === 'POST' && url === '/notes') {
            await this.handleNoteWrite(req, res);
            return;
        }

        this.sendJson(res, 404, { ok: false, error: 'not_found', message: 'Unknown endpoint' });
    }

    private isAuthorized(req: http.IncomingMessage): boolean {
        const header = req.headers['authorization'];
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
        const presented = header.slice('Bearer '.length).trim();
        const expected = this.settings.apiKey;
        if (!expected || presented.length !== expected.length) return false;
        try {
            return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
        } catch (_) {
            return false;
        }
    }

    private async handleNoteWrite(req: http.IncomingMessage, res: http.ServerResponse) {
        let body: string;
        try {
            body = await this.readBody(req);
        } catch (e: any) {
            this.sendJson(res, 413, { ok: false, error: 'too_large', message: e.message });
            return;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(body);
        } catch (_) {
            this.sendJson(res, 400, { ok: false, error: 'bad_json', message: 'Body must be JSON: {path, content}' });
            return;
        }

        if (typeof parsed.path !== 'string' || typeof parsed.content !== 'string') {
            this.sendJson(res, 400, { ok: false, error: 'bad_request', message: 'path and content must be strings' });
            return;
        }

        let vaultPath: string;
        try {
            vaultPath = this.sanitizeVaultPath(parsed.path);
        } catch (e: any) {
            this.sendJson(res, 400, { ok: false, error: 'bad_path', message: e.message });
            return;
        }

        // Skip-if-exists: same locked policy as everywhere else in the
        // product. The file being present means the meeting already landed;
        // the user's edits to it are never touched.
        if (this.app.vault.getAbstractFileByPath(vaultPath)) {
            this.sendJson(res, 200, { ok: true, skipped: true, path: vaultPath });
            return;
        }

        try {
            await this.ensureParentFolders(vaultPath);
            await this.app.vault.create(vaultPath, parsed.content);
        } catch (e: any) {
            // A race with another write can create the file between the probe
            // and create(); that is a skip, not a failure.
            if (this.app.vault.getAbstractFileByPath(vaultPath)) {
                this.sendJson(res, 200, { ok: true, skipped: true, path: vaultPath });
                return;
            }
            this.sendJson(res, 500, { ok: false, error: 'write_failed', message: String(e && e.message || e) });
            return;
        }

        this.settings.notesReceived += 1;
        this.saveSettings().catch(() => { /* counter is cosmetic */ });
        this.sendJson(res, 200, { ok: true, skipped: false, path: vaultPath });
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            req.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    reject(new Error(`Body exceeds ${MAX_BODY_BYTES} bytes`));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });
    }

    // Turns an untrusted path into a safe vault-relative path or throws.
    // Backslashes normalize to forward slashes, every segment is scrubbed of
    // characters that break on some OS, and traversal is impossible because
    // '..' and '' segments are rejected rather than resolved.
    private sanitizeVaultPath(raw: string): string {
        if (raw.length > MAX_PATH_LENGTH) throw new Error('Path too long');
        const unified = raw.replace(/\\/g, '/').replace(/^\/+/, '');
        const segments = unified.split('/').map((seg) => {
            const clean = seg.replace(/[:*?"<>|]/g, '_').trim();
            if (!clean || clean === '.' || clean === '..') {
                throw new Error('Path contains an empty or traversal segment');
            }
            return clean;
        });
        const joined = segments.join('/');
        if (!/\.md$/i.test(joined)) {
            throw new Error('Only .md files are accepted');
        }
        return normalizePath(joined);
    }

    private async ensureParentFolders(vaultPath: string) {
        const parts = vaultPath.split('/');
        parts.pop(); // filename
        let acc = '';
        for (const part of parts) {
            acc = acc ? acc + '/' + part : part;
            if (!this.app.vault.getAbstractFileByPath(acc)) {
                try {
                    await this.app.vault.createFolder(acc);
                } catch (e: any) {
                    // Concurrent requests race on folder creation; an
                    // already-exists failure is success.
                    if (!this.app.vault.getAbstractFileByPath(acc)) throw e;
                }
            }
        }
    }

    private sendJson(res: http.ServerResponse, status: number, payload: unknown) {
        if (res.writableEnded) return;
        const body = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
    }
}

// ----------------------------------------------------------------------
// Settings tab
// ----------------------------------------------------------------------

class SyncSettingTab extends PluginSettingTab {
    plugin: TranscriptExporterSyncPlugin;
    private statusEl: HTMLElement | null = null;
    private visible = false;

    constructor(app: App, plugin: TranscriptExporterSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    isVisible(): boolean {
        return this.visible;
    }

    hide() {
        this.visible = false;
    }

    renderStatus() {
        if (!this.statusEl) return;
        const state = this.plugin.getServerState();
        this.statusEl.empty();
        if (state.kind === 'listening') {
            this.statusEl.createEl('span', {
                text: `Running. Listening on 127.0.0.1:${state.port}`,
                cls: 'transcriptexporter-sync-status-ok'
            });
        } else if (state.kind === 'error') {
            this.statusEl.createEl('span', { text: state.message });
        } else {
            this.statusEl.createEl('span', { text: 'Stopped' });
        }
    }

    display(): void {
        this.visible = true;
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('p', {
            text: 'Pairs this vault with the TranscriptExporter Chrome extensions (Granola, Fathom, Fireflies). '
                + 'The extension delivers meeting notes to this plugin over your own machine '
                + '(127.0.0.1); nothing leaves your computer and no account is involved. '
                + 'Files already in your vault are never changed, so your edits are safe.'
        });

        const statusSetting = new Setting(containerEl)
            .setName('Status')
            .setDesc('');
        this.statusEl = statusSetting.descEl;
        this.renderStatus();

        new Setting(containerEl)
            .setName('Enable sync server')
            .setDesc('Turn off to stop accepting notes from the extension.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.serverEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.serverEnabled = value;
                    await this.plugin.saveSettings();
                    await this.plugin.restartServer();
                }));

        new Setting(containerEl)
            .setName('Port')
            .setDesc('The extension must use the same port. Change only if another app already uses this one.')
            .addText((text) => text
                .setValue(String(this.plugin.settings.port))
                .onChange(async (value) => {
                    const port = parseInt(value, 10);
                    if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
                    this.plugin.settings.port = port;
                    await this.plugin.saveSettings();
                    await this.plugin.restartServer();
                }));

        new Setting(containerEl)
            .setName('Pairing key')
            .setDesc('Copy this into the TranscriptExporter extension settings under Obsidian vault sync.')
            .addButton((btn) => btn
                .setButtonText('Copy key')
                .setCta()
                .onClick(async () => {
                    await navigator.clipboard.writeText(this.plugin.settings.apiKey);
                    new Notice('Pairing key copied');
                }))
            .addButton((btn) => btn
                .setButtonText('Regenerate')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.apiKey = randomBytes(24).toString('hex');
                    await this.plugin.saveSettings();
                    new Notice('New pairing key generated. Update the extension with the new key.');
                    this.display();
                }));

        const keyEl = containerEl.createEl('div', { cls: 'setting-item-description' });
        keyEl.createEl('code', { text: this.plugin.settings.apiKey });
    }
}
