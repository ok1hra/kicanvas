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

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    UsageError,
    collect_files,
    find_chrome,
    launch_browser,
    open_project,
    show_page,
    start_server,
} from "./lib/viewer-page.js";

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

let files, chrome;
try {
    files = collect_files(positionals);
    chrome = find_chrome(opts.chrome);
} catch (e) {
    if (e instanceof UsageError) {
        console.error(`render-check: ${e.message}`);
        process.exit(2);
    }
    throw e;
}

const out_dir = resolve(opts.out);
const timeout_ms = Number(opts.timeout) * 1000;
mkdirSync(out_dir, { recursive: true });

const server = await start_server();

const errors = [];
const parser_warnings = new Map();
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;

const browser = await launch_browser(chrome, {
    width: Number(opts.width),
    height: Number(opts.height),
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

    console.log(ts(), `loading ${files.length} files`);
    try {
        await open_project(page, server.url, files, timeout_ms);
    } catch (e) {
        errors.push("project did not finish loading");
        await page.screenshot({ path: join(out_dir, "load-failed.png") });
        throw e;
    }
    console.log(ts(), "project loaded");

    const pages = await page.evaluate(() =>
        [...window.__kc.shell().project.pages()].map((p) => ({
            type: p.type,
            filename: p.filename,
            name: p.name ?? "",
            page: p.page ?? "",
            project_path: p.project_path,
        })),
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
        const loaded = await show_page(page, p.project_path, timeout_ms);

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
    await server.dispose();
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
