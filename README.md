# TranscriptExporter Sync

Companion plugin for the [TranscriptExporter](https://www.transcriptexport.com) Chrome extensions (Granola, Fathom, Fireflies). The extension fetches your meeting notes and transcripts; this plugin receives them and writes them into your vault as Markdown - automatically, minutes after each call, with nothing to click.

One plugin serves every TranscriptExporter extension you use. Each writes into its own subfolder (`Granola/`, `Fathom/`, `Fireflies/`), so all your meetings end up in one vault, organized by source.

## How it works

The plugin runs a small HTTP server **on your own machine only** (`127.0.0.1`, default port 27125). The TranscriptExporter extension in Chrome delivers finished notes to it. That's the entire data path: Chrome to this plugin, over your own loopback interface.

- **Nothing leaves your computer.** The server is bound to 127.0.0.1 and is unreachable from your network or the internet. The plugin itself makes no outgoing network requests, ever - no telemetry, no update checks, no accounts.
- **Every request is authenticated.** A pairing key is generated on first run and compared in constant time; requests without it are rejected.
- **Only Markdown is accepted**, paths are sanitized, and path traversal is rejected.
- **Your edits are safe.** A file already in your vault is never modified or overwritten. New meetings are added; existing notes are yours.

## Setup

1. Install and enable the plugin.
2. Open Settings, then **TranscriptExporter Sync**, and click **Copy key**.
3. In your TranscriptExporter extension: Settings, Obsidian vault section, paste the key, click **Connect companion plugin**.

Repeat step 3 in each TranscriptExporter extension you use - the same key pairs all of them.

## Settings

- **Enable sync server** - turn receiving on or off.
- **Port** - change only if another app already uses 27125; the extension must match.
- **Pairing key** - copy it to the extension; regenerate it any time to revoke access (you'll need to reconnect the extension with the new key).

## Manual install

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/GOAT502-Digital/transcriptexporter-sync/releases).
2. Create the folder `<your vault>/.obsidian/plugins/transcriptexporter-sync/` and put both files in it.
3. In Obsidian: Settings, Community plugins, enable **TranscriptExporter Sync**.

## Building from source

```
npm install
npm run build
```

Produces `main.js` from `main.ts` via esbuild.

## Network use disclosure

This plugin opens a listening TCP socket on 127.0.0.1 (localhost) to receive notes from the TranscriptExporter browser extension running on the same machine. It never connects to any remote server, and nothing it handles is transmitted off your computer. The browser extension that sends the notes is a separate product with its own [privacy policy](https://www.transcriptexport.com/privacy-policy/).

## License

[MIT](LICENSE)
