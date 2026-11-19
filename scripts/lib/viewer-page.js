/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/*
    Shared helpers for scripts that drive KiCanvas in headless Chrome:
    building and serving KiCanvas, launching Chrome and loading a project
    into the standalone viewer.
*/

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { bundle } from "../bundle.js";

export const KICAD_FILE = /\.kicad_(pro|sch|pcb)$/;

const CHROME_CANDIDATES = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

export class UsageError extends Error {}

/**
 * Expands directories into the KiCad files directly inside of them.
 */
export function collect_files(paths) {
    const files = [];
    for (const p of paths) {
        const abs = resolve(p);
        if (!existsSync(abs)) {
            throw new UsageError(`${p} does not exist`);
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
            throw new UsageError(`${p} is not a KiCad file`);
        }
    }
    if (!files.length) {
        throw new UsageError("no KiCad files found");
    }
    return files;
}

export function find_chrome(explicit) {
    const path =
        explicit ??
        process.env["CHROME_PATH"] ??
        CHROME_CANDIDATES.find((c) => existsSync(c));
    if (!path || !existsSync(path)) {
        throw new UsageError(
            "could not find Chrome/Chromium, pass --chrome or set CHROME_PATH",
        );
    }
    return path;
}

/**
 * Builds KiCanvas in memory and serves it along with ./debug, like
 * `npm run serve` but on a free port and without writing to disk.
 *
 * @returns {{ url: string, dispose: () => Promise<void> }}
 */
export async function start_server() {
    const { context } = await bundle({
        outfile: "debug/kicanvas/kicanvas.js",
        write: false,
        logLevel: "error",
        plugins: [],
    });
    const build = await context.rebuild();
    if (build.errors.length) {
        await context.dispose();
        throw new Error(`build failed with ${build.errors.length} errors`);
    }
    const { port } = await context.serve({
        servedir: "./debug",
        host: "127.0.0.1",
    });
    return {
        url: `http://127.0.0.1:${port}/`,
        dispose: () => context.dispose(),
    };
}

export async function launch_browser(chrome, viewport) {
    return await puppeteer.launch({
        executablePath: chrome,
        headless: true,
        args: [
            // Software WebGL so that the board viewer works without a GPU.
            "--enable-unsafe-swiftshader",
            "--use-angle=swiftshader",
            // Don't throttle timers and rendering in background tabs.
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ],
        defaultViewport: viewport,
    });
}

/**
 * Opens the standalone viewer and loads files into it through the
 * "open from local" file picker.
 */
export async function open_project(page, url, files, timeout_ms) {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
        () =>
            document
                .querySelector("kc-kicanvas-shell")
                ?.shadowRoot?.querySelector('button[name="open_local"]'),
        { timeout: timeout_ms },
    );

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

    await page.waitForFunction(
        () =>
            document.querySelector("kc-kicanvas-shell").hasAttribute("loaded"),
        { timeout: timeout_ms, polling: 250 },
    );

    // Helpers for page.evaluate() calls.
    await page.evaluate(() => {
        window.__kc = {
            deep(root, selector) {
                const found = root.querySelector(selector);
                if (found) return found;
                for (const el of root.querySelectorAll("*")) {
                    if (el.shadowRoot) {
                        const f = window.__kc.deep(el.shadowRoot, selector);
                        if (f) return f;
                    }
                }
                return null;
            },
            shell: () => document.querySelector("kc-kicanvas-shell"),
            app: (tag) => window.__kc.deep(document, tag),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            // Two animation frames, but don't hang if the tab is in the
            // background (where requestAnimationFrame doesn't run).
            frames: () =>
                Promise.race([
                    new Promise((r) =>
                        requestAnimationFrame(() => requestAnimationFrame(r)),
                    ),
                    new Promise((r) => setTimeout(r, 200)),
                ]),
        };
    });
}

/**
 * Shows a project page and waits for its viewer to finish loading it.
 *
 * @returns {Promise<boolean>} whether the page loaded in time
 */
export async function show_page(page, project_path, timeout_ms) {
    // Viewers draw on animation frames, which only run in the front tab.
    await page.bringToFront();
    return await page.evaluate(
        async (project_path, timeout) => {
            const kc = window.__kc;
            const project = kc.shell().project;
            const target = [...project.pages()].find(
                (x) => x.project_path === project_path,
            );
            const app = kc.app(
                target.type === "pcb" ? "kc-board-app" : "kc-schematic-app",
            );

            // Prefer the viewer's load event; fall back to polling when the
            // document was already loaded (in which case no event fires).
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
                        kc.sleep(250).then(() => false),
                    ]);
                } else {
                    await kc.sleep(250);
                }
                if (!ok) {
                    ok =
                        !!v?.loaded?.isOpen &&
                        v.document === target.document &&
                        !app.hidden;
                    if (ok && event) {
                        await Promise.race([event, kc.sleep(1000)]);
                    }
                }
                if (ok) break;
            }
            await kc.frames();
            await kc.sleep(100);
            return ok;
        },
        project_path,
        timeout_ms,
    );
}
