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

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { basename, extname, join, relative, resolve, sep } from "node:path";
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

/*
    Git history of the project, for comparing revisions. The project
    directory is usually a git clone, or a directory in one.
*/
function git(...args) {
    return execFileSync("git", ["-C", project_dir, ...args], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
    });
}

let git_root = null;
try {
    git_root = git("rev-parse", "--show-toplevel").trim();
} catch {
    // Not in a git repository; comparing isn't available.
}
// The project's directory in the repository, e.g. "kicad" or "".
const git_subdir = git_root
    ? relative(git_root, project_dir).split(sep).join("/")
    : "";
const git_path = (name) => (git_subdir ? `${git_subdir}/${name}` : name);
const WORKTREE = "WORKTREE";
const is_rev = (rev) => rev == WORKTREE || /^[0-9a-f]{7,40}$/.test(rev);

function git_info() {
    if (!git_root) {
        return { available: false };
    }
    const dirty = git("status", "--porcelain", "--", ".").trim().length > 0;
    let branch = "";
    try {
        branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    } catch {
        // No commits yet.
    }
    return {
        available: true,
        repository: basename(git_root),
        subdir: git_subdir,
        branch,
        dirty,
    };
}

/** Commits that change the project's directory, newest first. */
function git_commits(limit = 500) {
    const out = git(
        "log",
        `-n${limit}`,
        "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
        "--",
        ".",
    );
    return out
        .split("\x1e")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [sha, short, author, date, subject] = line.split("\x1f");
            return { sha, short, author, date, subject };
        });
}

/** KiCad files directly in the project's directory at a revision. */
function git_files(rev) {
    if (rev == WORKTREE) {
        return kicad_files(project_dir);
    }
    // From the repository's root: ls-tree output is relative to the
    // current directory.
    const out = execFileSync(
        "git",
        ["-C", git_root, "ls-tree", "--name-only", `${rev}:${git_subdir}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
        .split("\n")
        .filter((f) => KICAD_FILE.test(f))
        .sort();
}

function git_file(rev, name) {
    if (rev == WORKTREE) {
        return readFileSync(join(project_dir, name));
    }
    return execFileSync(
        "git",
        ["-C", git_root, "show", `${rev}:${git_path(name)}`],
        { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
}

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

    // Git history, for comparing revisions.
    if (path.startsWith("/git/")) {
        try {
            const json = (value) =>
                send(JSON.stringify(value), content_types[".json"]);
            if (path == "/git/api/info") {
                return json(git_info());
            }
            if (git_root && path == "/git/api/commits") {
                return json(git_commits());
            }
            const rev = request_url.searchParams.get("rev") ?? "";
            if (git_root && path == "/git/api/files" && is_rev(rev)) {
                return json(git_files(rev));
            }
            // /git/rev/<rev>/<name>
            const m = /^\/git\/rev\/([^/]+)\/([^/]+)$/.exec(path);
            if (git_root && m && is_rev(m[1]) && KICAD_FILE.test(m[2])) {
                if (git_files(m[1]).includes(m[2])) {
                    return send(git_file(m[1], m[2]), "text/plain");
                }
            }
        } catch (e) {
            res.writeHead(500);
            return res.end(String(e.message ?? e));
        }
        res.writeHead(404);
        return res.end("Not found");
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
