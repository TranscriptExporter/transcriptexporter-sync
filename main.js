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
function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}
var TranscriptExporterSyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.server = null;
    this.sockets = /* @__PURE__ */ new Set();
    this.serverState = { kind: "stopped" };
    this.settingsTab = null;
    // One pending pairing request at a time; a decision or the 55s timeout
    // clears it. Long-poll: the HTTP response is held open until the user
    // decides, so the extension needs no second request.
    this.pairPending = false;
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
    const data = await this.loadData();
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      data != null ? data : {}
    );
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
        this.sendJson(res, 500, { ok: false, error: "internal", message: errorMessage(e) });
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
      this.refreshSettingsTab();
    });
    this.server = server;
  }
  stopServer() {
    if (this.server) {
      try {
        this.server.close();
      } catch (e) {
      }
      this.server = null;
    }
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch (e) {
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
    if (this.settingsTab) {
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
    if (req.method === "POST" && url === "/pair") {
      await this.handlePairRequest(req, res);
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
    } catch (e) {
      return false;
    }
  }
  async handleNoteWrite(req, res) {
    let body;
    try {
      body = await this.readBody(req);
    } catch (e) {
      this.sendJson(res, 413, { ok: false, error: "too_large", message: errorMessage(e) });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      this.sendJson(res, 400, { ok: false, error: "bad_json", message: "Body must be JSON: {path, content}" });
      return;
    }
    const note = parsed;
    if (typeof note.path !== "string" || typeof note.content !== "string") {
      this.sendJson(res, 400, { ok: false, error: "bad_request", message: "path and content must be strings" });
      return;
    }
    const rawPath = note.path;
    const content = note.content;
    let vaultPath;
    try {
      vaultPath = this.sanitizeVaultPath(rawPath);
    } catch (e) {
      this.sendJson(res, 400, { ok: false, error: "bad_path", message: errorMessage(e) });
      return;
    }
    if (this.app.vault.getAbstractFileByPath(vaultPath)) {
      this.sendJson(res, 200, { ok: true, skipped: true, path: vaultPath });
      return;
    }
    try {
      await this.ensureParentFolders(vaultPath);
      await this.app.vault.create(vaultPath, content);
    } catch (e) {
      if (this.app.vault.getAbstractFileByPath(vaultPath)) {
        this.sendJson(res, 200, { ok: true, skipped: true, path: vaultPath });
        return;
      }
      this.sendJson(res, 500, { ok: false, error: "write_failed", message: errorMessage(e) });
      return;
    }
    this.settings.notesReceived += 1;
    this.saveSettings().catch(() => {
    });
    this.sendJson(res, 200, { ok: true, skipped: false, path: vaultPath });
  }
  async handlePairRequest(req, res) {
    if (this.pairPending) {
      this.sendJson(res, 429, { ok: false, error: "busy", message: "A pairing request is already waiting for a decision in Obsidian" });
      return;
    }
    let body;
    try {
      body = await this.readBody(req);
    } catch (e) {
      this.sendJson(res, 413, { ok: false, error: "too_large", message: errorMessage(e) });
      return;
    }
    let requesterName = "A TranscriptExporter extension";
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.name === "string") {
        const clean = parsed.name.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 48);
        if (clean) requesterName = clean;
      }
    } catch (e) {
    }
    this.pairPending = true;
    let settled = false;
    const settle = (status, payload) => {
      if (settled) return;
      settled = true;
      this.pairPending = false;
      this.sendJson(res, status, payload);
    };
    const timer = window.setTimeout(() => {
      modal.close();
      settle(408, { ok: false, error: "timeout", message: "No decision was made in Obsidian" });
    }, 55e3);
    const modal = new PairApprovalModal(this.app, requesterName, (approved) => {
      window.clearTimeout(timer);
      if (approved) {
        settle(200, {
          ok: true,
          key: this.settings.apiKey,
          vault: this.app.vault.getName(),
          version: this.manifest.version
        });
      } else {
        settle(403, { ok: false, error: "denied", message: "The pairing request was denied in Obsidian" });
      }
    });
    modal.open();
    req.on("close", () => {
      if (!settled) {
        window.clearTimeout(timer);
        settled = true;
        this.pairPending = false;
        modal.close();
      }
    });
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
var PairApprovalModal = class extends import_obsidian.Modal {
  constructor(app, requesterName, onDecision) {
    super(app);
    this.decided = false;
    this.requesterName = requesterName;
    this.onDecision = onDecision;
  }
  decide(approved) {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(approved);
    this.close();
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Pairing request" });
    contentEl.createEl("p", {
      text: `"${this.requesterName}" wants to connect to TranscriptExporter Sync and write meeting notes into the vault "${this.app.vault.getName()}".`
    });
    contentEl.createEl("p", {
      text: "Only allow this if you just clicked Connect in the TranscriptExporter browser extension."
    });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    const allowBtn = row.createEl("button", { text: "Allow", cls: "mod-cta" });
    allowBtn.onclick = () => this.decide(true);
    const denyBtn = row.createEl("button", { text: "Deny" });
    denyBtn.onclick = () => this.decide(false);
  }
  onClose() {
    if (!this.decided) {
      this.decided = true;
      this.onDecision(false);
    }
    this.contentEl.empty();
  }
};
var SyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.statusEl = null;
    this.plugin = plugin;
  }
  hide() {
    this.statusEl = null;
  }
  renderStatus() {
    if (!this.statusEl || !this.statusEl.isConnected) return;
    const state = this.plugin.getServerState();
    this.statusEl.empty();
    if (state.kind === "listening") {
      this.statusEl.createSpan({
        text: `Running. Listening on 127.0.0.1:${state.port}`,
        cls: "transcriptexporter-sync-status-ok"
      });
    } else if (state.kind === "error") {
      this.statusEl.createSpan({ text: state.message });
    } else {
      this.statusEl.createSpan({ text: "Stopped" });
    }
  }
  buildStatusRow(setting) {
    setting.setName("Status").setDesc("");
    this.statusEl = setting.descEl;
    this.renderStatus();
  }
  buildEnableRow(setting) {
    setting.setName("Enable sync server").setDesc("Turn off to stop accepting notes from the extension.").addToggle((toggle) => toggle.setValue(this.plugin.settings.serverEnabled).onChange(async (value) => {
      this.plugin.settings.serverEnabled = value;
      await this.plugin.saveSettings();
      await this.plugin.restartServer();
    }));
  }
  buildPortRow(setting) {
    setting.setName("Port").setDesc("The extension must use the same port. Change only if another app already uses this one.").addText((text) => text.setValue(String(this.plugin.settings.port)).onChange(async (value) => {
      const port = parseInt(value, 10);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
      this.plugin.settings.port = port;
      await this.plugin.saveSettings();
      await this.plugin.restartServer();
    }));
  }
  buildPairingKeyRow(setting) {
    setting.setName("Pairing key").setDesc("Copy this into the TranscriptExporter extension settings under Obsidian vault sync.").addButton((btn) => btn.setButtonText("Copy key").setCta().onClick(async () => {
      await navigator.clipboard.writeText(this.plugin.settings.apiKey);
      new import_obsidian.Notice("Pairing key copied");
    })).addButton((btn) => {
      btn.setButtonText("Regenerate");
      const maybe = btn;
      if (typeof maybe.setDestructive === "function") {
        maybe.setDestructive();
      } else {
        btn.setWarning();
      }
      btn.onClick(async () => {
        this.plugin.settings.apiKey = (0, import_crypto.randomBytes)(24).toString("hex");
        await this.plugin.saveSettings();
        new import_obsidian.Notice("New pairing key generated. Update the extension with the new key.");
        this.display();
      });
    });
    setting.descEl.createEl("br");
    setting.descEl.createEl("code", { text: this.plugin.settings.apiKey });
  }
  getSettingDefinitions() {
    return [
      {
        name: "Status",
        desc: "Whether the local receiver is running.",
        render: (s) => this.buildStatusRow(s)
      },
      {
        name: "Enable sync server",
        desc: "Turn off to stop accepting notes from the extension.",
        render: (s) => this.buildEnableRow(s)
      },
      {
        name: "Port",
        desc: "The extension must use the same port.",
        render: (s) => this.buildPortRow(s)
      },
      {
        name: "Pairing key",
        desc: "Copy this into the TranscriptExporter extension settings.",
        render: (s) => this.buildPairingKeyRow(s)
      }
    ];
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", {
      text: "Pairs this vault with the TranscriptExporter Chrome extensions (Granola, Fathom, Fireflies). The extension delivers meeting notes to this plugin over your own machine (127.0.0.1); nothing leaves your computer and no account is involved. Files already in your vault are never changed, so your edits are safe."
    });
    this.buildStatusRow(new import_obsidian.Setting(containerEl));
    this.buildEnableRow(new import_obsidian.Setting(containerEl));
    this.buildPortRow(new import_obsidian.Setting(containerEl));
    this.buildPairingKeyRow(new import_obsidian.Setting(containerEl));
  }
};
