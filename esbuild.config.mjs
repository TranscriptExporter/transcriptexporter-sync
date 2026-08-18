import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv[2] === 'production';

// Node builtins stay external: Obsidian's desktop runtime (Electron)
// provides them at require() time; bundling shims would break net/http.
const nodeBuiltins = [
    'http', 'https', 'net', 'tls', 'crypto', 'url', 'events', 'stream',
    'buffer', 'path', 'fs', 'os', 'util', 'zlib', 'querystring'
];

const context = await esbuild.context({
    entryPoints: ['main.ts'],
    bundle: true,
    external: ['obsidian', 'electron', ...nodeBuiltins],
    format: 'cjs',
    target: 'es2018',
    logLevel: 'info',
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    outfile: 'main.js'
});

if (prod) {
    await context.rebuild();
    process.exit(0);
} else {
    await context.watch();
}
