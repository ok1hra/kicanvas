/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/*
    Opens a local KiCad project in KiCanvas: builds KiCanvas, serves it
    together with the project's files and opens the browser.

    Run `npm run open -- --help` for usage.
*/

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { bundle } from "./bundle.js";
import { KICAD_FILE } from "./lib/viewer-page.js";

const USAGE = `Usage: npm run open -- <project dir> [options]

Builds KiCanvas, serves it with the project's KiCad files on this computer
and opens it in the browser. If the directory has no KiCad files, the first
subdirectory (up to three levels down) with a .kicad_pro file is used.

Options:
  --port <n>      port to listen on (default: 8080, or the next free one)
  --no-browser    just print the URL
  --help          show this help`;

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        port: { type: "string", default: "8080" },
        "no-browser": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
    },
});

if (opts.help || positionals.length != 1) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
}

function kicad_files(dir) {
    return readdirSync(dir)
        .filter((f) => KICAD_FILE.test(f) && statSync(join(dir, f)).isFile())
        .sort();
}

/** The given directory, or the first one below it with a project file. */
function find_project_dir(dir, depth = 0) {
    const entries = readdirSync(dir);
    if (entries.some((f) => f.endsWith(".kicad_pro")) || depth == 0) {
        if (kicad_files(dir).length) {
            return dir;
        }
    }
    if (depth >= 3) {
        return null;
    }
    for (const name of entries.sort()) {
        const sub = join(dir, name);
        if (
            name.startsWith(".") ||
            name == "node_modules" ||
            name.endsWith("-backups") ||
            !statSync(sub).isDirectory()
        ) {
            continue;
        }
        const found = find_project_dir(sub, depth + 1);
        if (found) {
            return found;
        }
    }
    return null;
}

const requested = resolve(positionals[0]);
if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    console.error(`open: ${positionals[0]} is not a directory`);
    process.exit(2);
}
const project_dir = find_project_dir(requested);
if (!project_dir) {
    console.error(`open: no KiCad project found in ${positionals[0]}`);
    process.exit(2);
}
const files = kicad_files(project_dir);
// The project file first, so the project's settings are known early.
files.sort(
    (a, b) =>
        Number(b.endsWith(".kicad_pro")) - Number(a.endsWith(".kicad_pro")),
);

console.log(`Project: ${project_dir} (${files.length} files)`);

// Build KiCanvas.
const { context } = await bundle({
    outfile: "debug/kicanvas/kicanvas.js",
    write: false,
    logLevel: "error",
    plugins: [],
});
const build = await context.rebuild();
await context.dispose();
if (build.errors.length) {
    console.error(`open: build failed with ${build.errors.length} errors`);
    process.exit(1);
}
const kicanvas_js = build.outputFiles.find((f) =>
    f.path.endsWith(".js"),
).contents;

const debug_dir = resolve("debug");
const content_types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json",
};

let project_url = "/";

const server = http.createServer((req, res) => {
    const request_url = new URL(req.url, "http://x");
    const path = decodeURIComponent(request_url.pathname);

    // The bare address opens the project.
    if (path == "/" && !request_url.search) {
        res.writeHead(302, { Location: project_url });
        return res.end();
    }
    const send = (body, type) => {
        res.writeHead(200, {
            "Content-Type": type ?? "application/octet-stream",
            "Cache-Control": "no-store",
        });
        res.end(body);
    };

    if (path == "/favicon.ico") {
        res.writeHead(204);
        return res.end();
    }

    if (path == "/kicanvas/kicanvas.js") {
        return send(kicanvas_js, content_types[".js"]);
    }

    // Only the project's KiCad files are served from the project.
    if (path.startsWith("/project/")) {
        const name = path.slice("/project/".length);
        if (files.includes(name)) {
            return send(readFileSync(join(project_dir, name)), "text/plain");
        }
    } else {
        // The viewer page and its assets.
        const file = resolve(
            debug_dir,
            "." + (path == "/" ? "/index.html" : path),
        );
        if (
            file.startsWith(debug_dir + sep) &&
            existsSync(file) &&
            statSync(file).isFile()
        ) {
            return send(readFileSync(file), content_types[extname(file)]);
        }
    }

    res.writeHead(404);
    res.end("Not found");
});

function listen(port) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(port);
        });
    });
}

let port = Number(opts.port);
for (let attempt = 0; ; attempt++) {
    try {
        await listen(port);
        break;
    } catch (e) {
        if (e.code != "EADDRINUSE" || attempt >= 20) {
            throw e;
        }
        port++;
    }
}

const query = files
    .map((f) => `src=${encodeURIComponent(`project/${f}`)}`)
    .join("&");
project_url = `/?${query}`;
const url = `http://127.0.0.1:${port}/`;

console.log(
    `\nKiCanvas is running with ${basename(project_dir)}:\n\n  ${url}\n`,
);
console.log("Press Ctrl+C to stop.");

if (!opts["no-browser"]) {
    const opener =
        process.platform == "darwin"
            ? "open"
            : process.platform == "win32"
              ? "explorer"
              : "xdg-open";
    execFile(opener, [url], () => {
        // Ignore errors, e.g. no display; the URL is printed above.
    });
}
