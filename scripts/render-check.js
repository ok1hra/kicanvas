/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/*
    Render check: loads KiCad files into the standalone KiCanvas viewer
    running in headless Chrome, takes a screenshot of every page and reports
    browser errors. Useful for checking a change against a real project.

    Run `npm run render-check -- --help` for usage.
*/

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import { bundle } from "./bundle.js";

const USAGE = `Usage: npm run render-check -- <project dir or files...> [options]

Loads KiCad files (.kicad_pro, .kicad_sch, .kicad_pcb) into the KiCanvas
standalone viewer in headless Chrome, screenshots each page and reports
browser errors. A directory argument adds the KiCad files directly inside it
(not subdirectories).

Options:
  --out <dir>       screenshot directory (default: debug/render-check)
  --pages <list>    "all" (default), "first", or a comma-separated list of
                    file names and/or sheet names to capture
  --width <px>      viewport width (default: 1600)
  --height <px>     viewport height (default: 1000)
  --timeout <s>     seconds to wait for each load step (default: 120)
  --chrome <path>   Chrome/Chromium binary (default: $CHROME_PATH, else
                    autodetected)
  --help            show this help

Exits with status 1 if loading failed or any page error, console error or
failed request was seen.`;

const KICAD_FILE = /\.kicad_(pro|sch|pcb)$/;

const CHROME_CANDIDATES = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function fail(message) {
    console.error(`render-check: ${message}`);
    process.exit(2);
}

function collect_files(paths) {
    const files = [];
    for (const p of paths) {
        const abs = resolve(p);
        if (!existsSync(abs)) {
            fail(`${p} does not exist`);
        }
        if (statSync(abs).isDirectory()) {
            for (const name of readdirSync(abs).sort()) {
                const f = join(abs, name);
                if (KICAD_FILE.test(name) && statSync(f).isFile()) {
                    files.push(f);
                }
            }
        } else if (KICAD_FILE.test(abs)) {
            files.push(abs);
        } else {
            fail(`${p} is not a KiCad file`);
        }
    }
    if (!files.length) {
        fail("no KiCad files found");
    }
    return files;
}

function find_chrome(explicit) {
    const path =
        explicit ??
        process.env["CHROME_PATH"] ??
        CHROME_CANDIDATES.find((c) => existsSync(c));
    if (!path || !existsSync(path)) {
        fail(
            "could not find Chrome/Chromium, pass --chrome or set CHROME_PATH",
        );
    }
    return path;
}

function slug(s) {
    return (
        s
            .normalize("NFKD")
            .replace(/[^\w.-]+/g, "_")
            .replace(/^_+|_+$/g, "") || "page"
    );
}

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        out: { type: "string", default: "debug/render-check" },
        pages: { type: "string", default: "all" },
        width: { type: "string", default: "1600" },
        height: { type: "string", default: "1000" },
        timeout: { type: "string", default: "120" },
        chrome: { type: "string" },
        help: { type: "boolean", default: false },
    },
});

if (opts.help || !positionals.length) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
}

const files = collect_files(positionals);
const chrome = find_chrome(opts.chrome);
const out_dir = resolve(opts.out);
const timeout_ms = Number(opts.timeout) * 1000;
mkdirSync(out_dir, { recursive: true });

// Build KiCanvas in memory and serve it together with ./debug, the same way
// `npm run serve` does, but on a free port and without touching the disk.
const { context } = await bundle({
    outfile: "debug/kicanvas/kicanvas.js",
    write: false,
    logLevel: "error",
    plugins: [],
});
const build = await context.rebuild();
if (build.errors.length) {
    fail(`build failed with ${build.errors.length} errors`);
}
const { port } = await context.serve({
    servedir: "./debug",
    host: "127.0.0.1",
});
const base_url = `http://127.0.0.1:${port}/`;

const errors = [];
const parser_warnings = new Map();
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;

const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
        // Software WebGL so that the board viewer works without a GPU.
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
    ],
    defaultViewport: {
        width: Number(opts.width),
        height: Number(opts.height),
    },
});

let exit_code = 0;

try {
    const page = await browser.newPage();

    page.on("pageerror", (e) => {
        errors.push(`page error: ${e.message}`);
        console.log(ts(), "PAGE ERROR", e.message);
    });
    page.on("requestfailed", (r) => {
        errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`);
    });
    page.on("console", (m) => {
        // KiCanvas' logger formats messages as "%cname:%c" + CSS args.
        const text = m
            .text()
            .replace(/%c/g, "")
            .replace(/color: (ButtonText|inherit)\s*/g, "");
        if (m.type() === "error") {
            errors.push(`console error: ${text}`);
            return;
        }
        const unknown = text.match(
            /(?:No definition found for element|Bare element) ([^\s,]+)/,
        );
        if (unknown) {
            const token = unknown[1].replace(/^\(?/, "");
            parser_warnings.set(token, (parser_warnings.get(token) ?? 0) + 1);
        }
    });

    await page.goto(base_url, { waitUntil: "load" });
    await page.waitForFunction(
        () =>
            document
                .querySelector("kc-kicanvas-shell")
                ?.shadowRoot?.querySelector('button[name="open_local"]'),
        { timeout: timeout_ms },
    );

    console.log(ts(), `loading ${files.length} files`);
    const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: timeout_ms }),
        page.evaluate(() =>
            document
                .querySelector("kc-kicanvas-shell")
                .shadowRoot.querySelector('button[name="open_local"]')
                .click(),
        ),
    ]);
    await chooser.accept(files);

    try {
        await page.waitForFunction(
            () =>
                document
                    .querySelector("kc-kicanvas-shell")
                    .hasAttribute("loaded"),
            { timeout: timeout_ms, polling: 250 },
        );
    } catch {
        errors.push("project did not finish loading");
        await page.screenshot({ path: join(out_dir, "load-failed.png") });
        throw new Error("project did not finish loading");
    }
    console.log(ts(), "project loaded");

    const pages = await page.evaluate(() =>
        [...document.querySelector("kc-kicanvas-shell").project.pages()].map(
            (p) => ({
                type: p.type,
                filename: p.filename,
                name: p.name ?? "",
                page: p.page ?? "",
                project_path: p.project_path,
            }),
        ),
    );

    let selected = pages;
    if (opts.pages === "first") {
        selected = pages.slice(0, 1);
    } else if (opts.pages !== "all") {
        const wanted = opts.pages.split(",").map((s) => s.trim());
        selected = pages.filter(
            (p) => wanted.includes(p.filename) || wanted.includes(p.name),
        );
        if (!selected.length) {
            throw new Error(`no pages match --pages ${opts.pages}`);
        }
    }

    for (const [i, p] of selected.entries()) {
        const label = p.name ? `${p.name} (${p.filename})` : p.filename;

        const loaded = await page.evaluate(
            async (project_path, timeout) => {
                const deep_query = (root, selector) => {
                    const found = root.querySelector(selector);
                    if (found) return found;
                    for (const el of root.querySelectorAll("*")) {
                        if (el.shadowRoot) {
                            const f = deep_query(el.shadowRoot, selector);
                            if (f) return f;
                        }
                    }
                    return null;
                };
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                const frames = () =>
                    new Promise((r) =>
                        requestAnimationFrame(() => requestAnimationFrame(r)),
                    );

                const shell = document.querySelector("kc-kicanvas-shell");
                const project = shell.project;
                const target = [...project.pages()].find(
                    (x) => x.project_path === project_path,
                );
                const app = deep_query(
                    shell.shadowRoot,
                    target.type === "pcb" ? "kc-board-app" : "kc-schematic-app",
                );

                // Prefer the viewer's load event; fall back to polling when
                // the viewer doesn't exist yet or the document was already
                // loaded (in which case no event is fired).
                const viewer = app?.viewer;
                const event = viewer
                    ? new Promise((r) =>
                          viewer.addEventListener("kicanvas:load", r, {
                              once: true,
                          }),
                      )
                    : null;

                project.set_active_page(target);

                const deadline = Date.now() + timeout;
                let ok = false;
                while (Date.now() < deadline) {
                    const v = app?.viewer;
                    if (event) {
                        ok = await Promise.race([
                            event.then(() => true),
                            sleep(250).then(() => false),
                        ]);
                    } else {
                        await sleep(250);
                    }
                    if (!ok) {
                        ok =
                            !!v?.loaded?.isOpen &&
                            v.document === target.document &&
                            !app.hidden;
                        // Give a reload that's in flight a chance to finish.
                        if (ok && event) {
                            await Promise.race([event, sleep(1000)]);
                        }
                    }
                    if (ok) break;
                }
                await frames();
                await sleep(100);
                return ok;
            },
            p.project_path,
            timeout_ms,
        );

        const file = join(
            out_dir,
            `${String(i).padStart(2, "0")}-${slug(p.name || p.filename)}.png`,
        );
        await page.screenshot({ path: file });

        if (loaded) {
            console.log(ts(), `ok      ${label}`);
        } else {
            errors.push(`page did not load: ${label}`);
            console.log(ts(), `TIMEOUT ${label}`);
        }
    }

    console.log(ts(), `screenshots saved to ${out_dir}`);
} catch (e) {
    console.log(ts(), `FAILED: ${e.message}`);
    exit_code = 1;
} finally {
    await browser.close();
    await context.dispose();
}

if (parser_warnings.size) {
    console.log("\nTokens the parser skipped (token: occurrences):");
    for (const [token, n] of [...parser_warnings].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(6)}  ${token}`);
    }
}

const problems = [...new Set(errors)];
if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const e of problems) {
        console.log(`  - ${e}`);
    }
    exit_code = 1;
} else {
    console.log("\nNo browser errors.");
}

process.exit(exit_code);
