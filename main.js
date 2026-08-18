var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => TranscriptExporterSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var http = __toESM(require("http"));
var import_crypto = require("crypto");
var DEFAULT_PORT = 27125;
var MAX_BODY_BYTES = 10 * 1024 * 1024;
var MAX_PATH_LENGTH = 512;
var DEFAULT_SETTINGS = {
  serverEnabled: true,
  port: DEFAULT_PORT,
  apiKey: "",
  notesReceived: 0
};
var TranscriptExporterSyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.server = null;
    this.sockets = /* @__PURE__ */ new Set();
    this.serverState = { kind: "stopped" };
    this.settingsTab = null;
  }
  async onload() {
    await this.loadSettings();
    if (!this.settings.apiKey) {
      this.settings.apiKey = (0, import_crypto.randomBytes)(24).toString("hex");
      await this.saveSettings();
    }
    this.settingsTab = new SyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    if (this.settings.serverEnabled) {
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
  getServerState() {
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
        this.sendJson(res, 500, { ok: false, error: "internal", message: String(e && e.message || e) });
      });
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.on("error", (e) => {
      const message = e.code === "EADDRINUSE" ? `Port ${port} is already in use. Pick a different port in the plugin settings.` : `Server error: ${e.message}`;
      this.serverState = { kind: "error", message };
      this.server = null;
      new import_obsidian.Notice("TranscriptExporter Sync: " + message);
      this.refreshSettingsTab();
    });
    server.listen(port, "127.0.0.1", () => {
      this.serverState = { kind: "listening", port };
      console.log(`TranscriptExporter Sync listening on 127.0.0.1:${port}`);
      this.refreshSettingsTab();
    });
    this.server = server;
  }
  stopServer() {
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {
      }
      this.server = null;
    }
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch (_) {
      }
    }
    this.sockets.clear();
    this.serverState = { kind: "stopped" };
    this.refreshSettingsTab();
  }
  async restartServer() {
    if (this.settings.serverEnabled) {
      this.startServer();
    } else {
      this.stopServer();
    }
  }
  refreshSettingsTab() {
    if (this.settingsTab && this.settingsTab.isVisible()) {
      this.settingsTab.renderStatus();
    }
  }
  // ------------------------------------------------------------------
  // Request handling
  // ------------------------------------------------------------------
  async handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = (req.url || "/").split("?")[0];
    if (req.method === "GET" && url === "/ping") {
      this.sendJson(res, 200, {
        ok: true,
        app: "transcriptexporter-sync",
        version: this.manifest.version
      });
      return;
    }
    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { ok: false, error: "unauthorized", message: "Missing or invalid pairing key" });
      return;
    }
    if (req.method === "GET" && url === "/status") {
      this.sendJson(res, 200, {
        ok: true,
        app: "transcriptexporter-sync",
        version: this.manifest.version,
        vault: this.app.vault.getName(),
        notesReceived: this.settings.notesReceived
      });
      return;
    }
    if (req.method === "POST" && url === "/notes") {
      await this.handleNoteWrite(req, res);
      return;
    }
    this.sendJson(res, 404, { ok: false, error: "not_found", message: "Unknown endpoint" });
  }
  isAuthorized(req) {
    const header = req.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const presented = header.slice("Bearer ".length).trim();
    const expected = this.settings.apiKey;
    if (!expected || presented.length !== expected.length) return false;
    try {
      return (0, import_crypto.timingSafeEqual)(Buffer.from(presented), Buffer.from(expected));
    } catch (_) {
      return false;
    }
  }
  async handleNoteWrite(req, res) {
    let body;
    try {
      body = await this.readBody(req);
    } catch (e) {
      this.sendJson(res, 413, { ok: false, error: "too_large", message: e.message });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      this.sendJson(res, 400, { ok: false, error: "bad_json", message: "Body must be JSON: {path, content}" });
      return;
    }
    if (typeof parsed.path !== "string" || typeof parsed.content !== "string") {
      this.sendJson(res, 400, { ok: false, error: "bad_request", message: "path and content must be strings" });
      return;
    }
    let vaultPath;
    try {
      vaultPath = this.sanitizeVaultPath(parsed.path);
    } catch (e) {
      this.sendJson(res, 400, { ok: false, error: "bad_path", message: e.message });
      return;
    }
    if (this.app.vault.getAbstractFileByPath(vaultPath)) {
      this.sendJson(res, 200, { ok: true, skipped: true, path: vaultPath });
      return;
    }
    try {
      await this.ensureParentFolders(vaultPath);
      await this.app.vault.create(vaultPath, parsed.content);
    } catch (e) {
      if (this.app.vault.getAbstractFileByPath(vaultPath)) {
        this.sendJson(res, 200, { ok: true, skipped: true, path: vaultPath });
        return;
      }
      this.sendJson(res, 500, { ok: false, error: "write_failed", message: String(e && e.message || e) });
      return;
    }
    this.settings.notesReceived += 1;
    this.saveSettings().catch(() => {
    });
    this.sendJson(res, 200, { ok: true, skipped: false, path: vaultPath });
  }
  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error(`Body exceeds ${MAX_BODY_BYTES} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
  // Turns an untrusted path into a safe vault-relative path or throws.
  // Backslashes normalize to forward slashes, every segment is scrubbed of
  // characters that break on some OS, and traversal is impossible because
  // '..' and '' segments are rejected rather than resolved.
  sanitizeVaultPath(raw) {
    if (raw.length > MAX_PATH_LENGTH) throw new Error("Path too long");
    const unified = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = unified.split("/").map((seg) => {
      const clean = seg.replace(/[:*?"<>|]/g, "_").trim();
      if (!clean || clean === "." || clean === "..") {
        throw new Error("Path contains an empty or traversal segment");
      }
      return clean;
    });
    const joined = segments.join("/");
    if (!/\.md$/i.test(joined)) {
      throw new Error("Only .md files are accepted");
    }
    return (0, import_obsidian.normalizePath)(joined);
  }
  async ensureParentFolders(vaultPath) {
    const parts = vaultPath.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      if (!this.app.vault.getAbstractFileByPath(acc)) {
        try {
          await this.app.vault.createFolder(acc);
        } catch (e) {
          if (!this.app.vault.getAbstractFileByPath(acc)) throw e;
        }
      }
    }
  }
  sendJson(res, status, payload) {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }
};
var SyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.statusEl = null;
    this.visible = false;
    this.plugin = plugin;
  }
  isVisible() {
    return this.visible;
  }
  hide() {
    this.visible = false;
  }
  renderStatus() {
    if (!this.statusEl) return;
    const state = this.plugin.getServerState();
    this.statusEl.empty();
    if (state.kind === "listening") {
      this.statusEl.createEl("span", {
        text: `Running. Listening on 127.0.0.1:${state.port}`,
        cls: "transcriptexporter-sync-status-ok"
      });
    } else if (state.kind === "error") {
      this.statusEl.createEl("span", { text: state.message });
    } else {
      this.statusEl.createEl("span", { text: "Stopped" });
    }
  }
  display() {
    this.visible = true;
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "Pairs this vault with the TranscriptExporter Chrome extensions (Granola, Fathom, Fireflies). The extension delivers meeting notes to this plugin over your own machine (127.0.0.1); nothing leaves your computer and no account is involved. Files already in your vault are never changed, so your edits are safe."
    });
    const statusSetting = new import_obsidian.Setting(containerEl).setName("Status").setDesc("");
    this.statusEl = statusSetting.descEl;
    this.renderStatus();
    new import_obsidian.Setting(containerEl).setName("Enable sync server").setDesc("Turn off to stop accepting notes from the extension.").addToggle((toggle) => toggle.setValue(this.plugin.settings.serverEnabled).onChange(async (value) => {
      this.plugin.settings.serverEnabled = value;
      await this.plugin.saveSettings();
      await this.plugin.restartServer();
    }));
    new import_obsidian.Setting(containerEl).setName("Port").setDesc("The extension must use the same port. Change only if another app already uses this one.").addText((text) => text.setValue(String(this.plugin.settings.port)).onChange(async (value) => {
      const port = parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
      this.plugin.settings.port = port;
      await this.plugin.saveSettings();
      await this.plugin.restartServer();
    }));
    new import_obsidian.Setting(containerEl).setName("Pairing key").setDesc("Copy this into the TranscriptExporter extension settings under Obsidian vault sync.").addButton((btn) => btn.setButtonText("Copy key").setCta().onClick(async () => {
      await navigator.clipboard.writeText(this.plugin.settings.apiKey);
      new import_obsidian.Notice("Pairing key copied");
    })).addButton((btn) => btn.setButtonText("Regenerate").setWarning().onClick(async () => {
      this.plugin.settings.apiKey = (0, import_crypto.randomBytes)(24).toString("hex");
      await this.plugin.saveSettings();
      new import_obsidian.Notice("New pairing key generated. Update the extension with the new key.");
      this.display();
    }));
    const keyEl = containerEl.createEl("div", { cls: "setting-item-description" });
    keyEl.createEl("code", { text: this.plugin.settings.apiKey });
  }
};
