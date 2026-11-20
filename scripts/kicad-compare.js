/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/*
    KiCad comparison: renders a project's schematic sheets and board copper
    layers with KiCad (kicad-cli) and with KiCanvas, and measures how well
    they match.

    Run `npm run kicad-compare -- --help` for usage.
*/

import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
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

const USAGE = `Usage: npm run kicad-compare -- <project dir> [options]

Exports the project's schematic sheets and board layers as SVG with KiCad's
kicad-cli, renders the same with KiCanvas in headless Chrome, and compares
them. For each sheet/layer it reports:

  recall     share of KiCad's drawing that KiCanvas also draws
  precision  share of KiCanvas' drawing that KiCad also draws

(both within --tolerance pixels), and writes the images and a diff (red:
only KiCad draws it, blue: only KiCanvas does) plus an index.html report.

Options:
  --out <dir>        output directory (default: debug/kicad-compare/<project>)
  --sheets <list>    "all" (default), "none", or comma-separated sheet names
  --layers <list>    "copper" (default), "none", or comma-separated layers
  --width <px>       image width (default: 2400)
  --tolerance <px>   how far apart matching pixels can be (default: 2)
  --kicad-cli <cmd>  kicad-cli command (default: $KICAD_CLI, else the
                     official KiCad flatpak, else kicad-cli)
  --no-export        reuse SVGs exported by a previous run
  --chrome <path>    Chrome/Chromium binary
  --timeout <s>      seconds to wait for each load step (default: 120)
  --help             show this help

Exits with status 1 if loading fails.`;

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        out: { type: "string" },
        sheets: { type: "string", default: "all" },
        layers: { type: "string", default: "copper" },
        width: { type: "string", default: "2400" },
        tolerance: { type: "string", default: "2" },
        "kicad-cli": { type: "string" },
        "no-export": { type: "boolean", default: false },
        chrome: { type: "string" },
        timeout: { type: "string", default: "120" },
        help: { type: "boolean", default: false },
    },
});

if (opts.help || positionals.length != 1) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
}

const project_dir = resolve(positionals[0]);
let files, chrome;
try {
    files = collect_files([project_dir]);
    chrome = find_chrome(opts.chrome);
} catch (e) {
    if (e instanceof UsageError) {
        console.error(`kicad-compare: ${e.message}`);
        process.exit(2);
    }
    throw e;
}

const pro = files.find((f) => f.endsWith(".kicad_pro"));
if (!pro) {
    console.error("kicad-compare: no .kicad_pro file found");
    process.exit(2);
}
const project_name = basename(pro, ".kicad_pro");
const root_sch = join(project_dir, `${project_name}.kicad_sch`);
const board_file = join(project_dir, `${project_name}.kicad_pcb`);

const out_dir = resolve(opts.out ?? join("debug/kicad-compare", project_name));
const svg_dir = join(out_dir, "kicad");
const width = Number(opts.width);
const tolerance = Number(opts.tolerance);
const timeout_ms = Number(opts.timeout) * 1000;

function kicad_cli_command() {
    const cmd =
        opts["kicad-cli"] ??
        process.env["KICAD_CLI"] ??
        (has_flatpak_kicad()
            ? "flatpak run --command=kicad-cli org.kicad.KiCad"
            : "kicad-cli");
    return cmd.split(" ");
}

function has_flatpak_kicad() {
    try {
        execFileSync("flatpak", ["info", "org.kicad.KiCad"], {
            stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

function kicad_cli(...args) {
    const [cmd, ...pre] = kicad_cli_command();
    execFileSync(cmd, [...pre, ...args], { stdio: "pipe" });
}

const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;

// 1. Export from KiCad.
if (!opts["no-export"]) {
    rmSync(svg_dir, { recursive: true, force: true });
    mkdirSync(join(svg_dir, "sch"), { recursive: true });
    mkdirSync(join(svg_dir, "pcb"), { recursive: true });
    console.log(ts(), `exporting with ${kicad_cli_command().join(" ")}`);

    if (opts.sheets != "none" && existsSync(root_sch)) {
        kicad_cli(
            "sch",
            "export",
            "svg",
            "--black-and-white",
            "--exclude-drawing-sheet",
            "--output",
            join(svg_dir, "sch"),
            root_sch,
        );
    }
    if (opts.layers != "none" && existsSync(board_file)) {
        // All copper layers; the ones that don't exist are skipped.
        const copper = [
            "F.Cu",
            ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`),
            "B.Cu",
        ];
        const layers =
            opts.layers == "copper" ? copper : opts.layers.split(",");
        kicad_cli(
            "pcb",
            "export",
            "svg",
            "--mode-multi",
            "--layers",
            [...new Set([...layers, "Edge.Cuts"])].join(","),
            "--black-and-white",
            "--exclude-drawing-sheet",
            "--page-size-mode",
            "2",
            // Holes as they are; KiCanvas' hole colors count as background
            // when comparing.
            "--drill-shape-opt",
            "2",
            "--output",
            join(svg_dir, "pcb"),
            board_file,
        );
    }
}

const sch_svgs = existsSync(join(svg_dir, "sch"))
    ? readdirSync(join(svg_dir, "sch")).filter((f) => f.endsWith(".svg"))
    : [];
const pcb_svgs = existsSync(join(svg_dir, "pcb"))
    ? readdirSync(join(svg_dir, "pcb")).filter((f) => f.endsWith(".svg"))
    : [];
console.log(
    ts(),
    `${sch_svgs.length} sheet and ${pcb_svgs.length} board SVGs from KiCad`,
);

/** Rewrites an SVG's size and viewBox. */
function frame_svg(svg, view, px_width, px_height) {
    return svg.replace(/<svg\b[^>]*>/, (tag) =>
        tag
            .replace(/\swidth="[^"]*"/, ` width="${px_width}"`)
            .replace(/\sheight="[^"]*"/, ` height="${px_height}"`)
            .replace(
                /\sviewBox="[^"]*"/,
                ` viewBox="${view.x} ${view.y} ${view.w} ${view.h}"`,
            ),
    );
}

function svg_size(svg) {
    const m = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg);
    return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
}

/** End points of the paths in a KiCad SVG */
function svg_points(svg) {
    const points = [];
    for (const m of svg.matchAll(
        /[ML]\s*(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g,
    )) {
        points.push([+m[1], +m[2]]);
    }
    return points;
}

/**
 * Finds the translation from board coordinates to the SVG's coordinates by
 * matching the board's Edge.Cuts end points to the SVG's path end points.
 */
function find_offset(board_points, svg_pts) {
    if (!board_points.length || !svg_pts.length) {
        return null;
    }
    const near = (a, b) =>
        Math.abs(a[0] - b[0]) < 0.02 && Math.abs(a[1] - b[1]) < 0.02;
    let best = null;
    let best_score = 0;
    const b0 = board_points[0];
    for (const s of svg_pts) {
        const t = [s[0] - b0[0], s[1] - b0[1]];
        let score = 0;
        for (const b of board_points) {
            const moved = [b[0] + t[0], b[1] + t[1]];
            if (svg_pts.some((p) => near(p, moved))) {
                score++;
            }
        }
        if (score > best_score) {
            best_score = score;
            best = t;
        }
    }
    return best_score >= Math.min(3, board_points.length) ? best : null;
}

const server = await start_server();
const browser = await launch_browser(chrome, { width: 1600, height: 1000 });
const results = [];
let exit_code = 0;

/** Rasterizes an SVG into a PNG data URL */
async function rasterize_svg(page, svg, w, h) {
    await page.bringToFront();
    await page.setViewport({ width: w, height: h });
    const data = Buffer.from(svg).toString("base64");
    await page.setContent(
        `<html><body style="margin:0;background:#fff">` +
            `<img id="i" style="display:block;width:${w}px;height:${h}px" ` +
            `src="data:image/svg+xml;base64,${data}"></body></html>`,
        { waitUntil: "load" },
    );
    await page.waitForFunction(() => document.getElementById("i").complete);
    return (
        "data:image/png;base64," +
        (await page.screenshot({ encoding: "base64", omitBackground: false }))
    );
}

/**
 * Compares two images. "Ink" is what differs from the background: dark
 * pixels for schematics (dark on light), anything but the background for
 * boards (light on dark) and KiCad's black and white plots.
 */
async function compare(page, kicad_png, kicanvas_png, kind) {
    await page.setContent("<html><body></body></html>");
    return await page.evaluate(
        async (kicad_png, kicanvas_png, kind, tolerance) => {
            const load = (src) =>
                new Promise((resolve) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.src = src;
                });
            const [a, b] = await Promise.all([
                load(kicad_png),
                load(kicanvas_png),
            ]);
            const w = Math.min(a.width, b.width);
            const h = Math.min(a.height, b.height);
            const pixels = (img) => {
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0);
                return ctx.getImageData(0, 0, w, h).data;
            };
            const pa = pixels(a);
            const pb = pixels(b);

            const mask = (p, ink) => {
                const m = new Uint8Array(w * h);
                for (let i = 0; i < w * h; i++) {
                    m[i] = ink(p[i * 4], p[i * 4 + 1], p[i * 4 + 2]) ? 1 : 0;
                }
                return m;
            };
            const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
            // KiCad's black and white plots.
            const ink_kicad = (r, g, b) => lum(r, g, b) < 200;
            const bg = [pb[0], pb[1], pb[2]];
            const bg_lum = lum(bg[0], bg[1], bg[2]);
            const ink_kicanvas =
                kind == "sch"
                    ? // Colored lines on a light background: darker than the
                      // background or strongly colored. Thin anti-aliased
                      // lines are light, and symbol body fills are light and
                      // only slightly colored.
                      (r, g, b) =>
                          bg_lum - lum(r, g, b) > 30 ||
                          Math.max(r, g, b) - Math.min(r, g, b) > 90
                    : // Anything but the dark background.
                      (r, g, b) =>
                          Math.max(
                              Math.abs(r - bg[0]),
                              Math.abs(g - bg[1]),
                              Math.abs(b - bg[2]),
                          ) > 60;

            const ma = mask(pa, ink_kicad);
            const mb = mask(pb, ink_kicanvas);

            const dilate = (m, r) => {
                const tmp = new Uint8Array(w * h);
                const out = new Uint8Array(w * h);
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        let v = 0;
                        for (let dx = -r; dx <= r && !v; dx++) {
                            const xx = x + dx;
                            if (xx >= 0 && xx < w) v = m[y * w + xx];
                        }
                        tmp[y * w + x] = v;
                    }
                }
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        let v = 0;
                        for (let dy = -r; dy <= r && !v; dy++) {
                            const yy = y + dy;
                            if (yy >= 0 && yy < h) v = tmp[yy * w + x];
                        }
                        out[y * w + x] = v;
                    }
                }
                return out;
            };
            const da = dilate(ma, tolerance);
            const db = dilate(mb, tolerance);

            // Gaps (background), which matter for boards where copper pours
            // fill most of the area.
            const invert = (m) => m.map((v) => 1 - v);
            const ga = invert(ma);
            const gb = invert(mb);
            const dga = dilate(ga, tolerance);
            const dgb = dilate(gb, tolerance);
            let ga_total = 0,
                ga_hit = 0,
                gb_total = 0,
                gb_hit = 0;
            for (let i = 0; i < w * h; i++) {
                if (ga[i]) {
                    ga_total++;
                    if (dgb[i]) ga_hit++;
                }
                if (gb[i]) {
                    gb_total++;
                    if (dga[i]) gb_hit++;
                }
            }

            let a_total = 0,
                a_hit = 0,
                b_total = 0,
                b_hit = 0;
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const ctx = c.getContext("2d");
            const diff = ctx.createImageData(w, h);
            for (let i = 0; i < w * h; i++) {
                let color = [255, 255, 255];
                if (ma[i]) {
                    a_total++;
                    if (db[i]) {
                        a_hit++;
                        color = [190, 190, 190];
                    } else {
                        color = [220, 0, 0];
                    }
                }
                if (mb[i]) {
                    b_total++;
                    if (da[i]) {
                        b_hit++;
                    } else {
                        color = [0, 80, 255];
                    }
                }
                diff.data.set([...color, 255], i * 4);
            }
            ctx.putImageData(diff, 0, 0);

            return {
                recall: a_total ? a_hit / a_total : 1,
                precision: b_total ? b_hit / b_total : 1,
                gap_recall: ga_total ? ga_hit / ga_total : 1,
                gap_precision: gb_total ? gb_hit / gb_total : 1,
                kicad_ink: a_total,
                kicanvas_ink: b_total,
                diff: c.toDataURL("image/png"),
            };
        },
        kicad_png,
        kicanvas_png,
        kind,
        tolerance,
    );
}

function save_png(name, data_url) {
    writeFileSync(
        join(out_dir, name),
        Buffer.from(data_url.split(",")[1], "base64"),
    );
}

const slug = (s) =>
    s
        .normalize("NFKD")
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "page";

/** Puts the viewer into a plain, full window state for screenshots. */
async function prepare_capture(page, which) {
    await page.evaluate((which) => {
        const kc = window.__kc;
        const shell = kc.shell();
        // Show only one of the two panes.
        shell.has_schematic = which == "sch";
        shell.has_board = which == "pcb";
        for (const tag of ["kc-schematic-app", "kc-board-app"]) {
            const app = kc.app(tag);
            if (!app) continue;
            for (const sel of [
                "kc-ui-floating-panel",
                "kc-ui-floating-toolbar",
                "kc-viewer-bottom-toolbar",
            ]) {
                const el = kc.deep(app.shadowRoot, sel);
                if (el) el.style.display = "none";
            }
        }
        kc.deep(document, "kc-part-info")?.hide();
        for (const sel of ["main > .center-bar", "main > .status"]) {
            const el = shell.shadowRoot.querySelector(sel);
            if (el) el.style.display = "none";
        }
    }, which);
}

/** Frames the viewer on a box (in document coordinates) and screenshots it */
async function capture(page, which, box, w, h, setup) {
    // The viewer draws on animation frames, which only run in the front tab.
    await page.bringToFront();
    await page.setViewport({ width: w, height: h });
    await page.evaluate(
        async (which, box, setup) => {
            const kc = window.__kc;
            const app = kc.app(
                which == "sch" ? "kc-schematic-app" : "kc-board-app",
            );
            const v = app.viewer;
            // Wait for the viewer to pick up the new canvas size, otherwise
            // the camera is fitted to the old size.
            for (let i = 0, stable = 0; i < 100 && stable < 3; i++) {
                await kc.sleep(50);
                const c = v.canvas;
                const ok =
                    c.clientWidth > 0 &&
                    v.viewport.width == c.clientWidth &&
                    v.viewport.height == c.clientHeight &&
                    Math.abs(c.clientWidth - window.innerWidth) < 4;
                stable = ok ? stable + 1 : 0;
            }
            // Plain drawing: no page frame, grid or highlights.
            for (const name of [":DrawingSheet", ":Grid"]) {
                const l = v.layers.by_name(name);
                if (l) l.visible = false;
            }
            v.select(null);
            if (setup.layer && !kc.holes_as_background) {
                // Draw holes in the background color, like the empty holes
                // in KiCad's plots. (Pad holes already are.)
                const t = v.theme;
                v.theme = Object.assign(
                    Object.create(Object.getPrototypeOf(t)),
                    t,
                    { via_hole: t.background, non_plated_hole: t.background },
                );
                v.paint();
                kc.holes_as_background = true;
            }
            if (setup.layer) {
                for (const l of v.layers.in_ui_order()) {
                    l.visible = l.name == setup.layer;
                }
                // No net names or anchors, which KiCad's plots don't have.
                for (const l of v.layers.in_order()) {
                    if (/NetName|Anchors/.test(l.name)) {
                        l.visible = false;
                    }
                }
            }
            const { BBox } = { BBox: v.viewport.camera.bbox.constructor };
            v.viewport.camera.bbox = new BBox(box.x, box.y, box.w, box.h);
            v.viewport.user_moved_camera = true;
            v.draw();
            await kc.frames();
            await kc.sleep(150);
        },
        which,
        box,
        setup ?? {},
    );
    const rect = await page.evaluate((which) => {
        const app = window.__kc.app(
            which == "sch" ? "kc-schematic-app" : "kc-board-app",
        );
        const r = app.viewer.canvas.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, which);
    return (
        "data:image/png;base64," +
        (await page.screenshot({ encoding: "base64", clip: rect }))
    );
}

try {
    mkdirSync(out_dir, { recursive: true });
    const page = await browser.newPage();
    const scratch = await browser.newPage();
    page.on("pageerror", (e) => console.log(ts(), "PAGE ERROR", e.message));

    console.log(ts(), `loading ${files.length} files`);
    await open_project(page, server.url, files, timeout_ms);
    console.log(ts(), "project loaded");

    // 2. Schematic sheets.
    const sheets = await page.evaluate(() => {
        const project = window.__kc.shell().project;
        return [...project.pages()]
            .filter(
                (p) =>
                    p.type == "schematic" &&
                    (p.page !== undefined || p == project.root_schematic_page),
            )
            .map((p) => {
                const doc = p.document;
                const paper = doc.paper;
                return {
                    project_path: p.project_path,
                    name: p.name,
                    human_path: project.human_sheet_path(p.sheet_path),
                    page_w: paper?.width,
                    page_h: paper?.height,
                };
            });
    });

    const wanted_sheets =
        opts.sheets == "all"
            ? null
            : opts.sheets.split(",").map((s) => s.trim());

    if (opts.sheets != "none" && sheets.length) {
        await prepare_capture(page, "sch");
    }

    for (const sheet of opts.sheets == "none" ? [] : sheets) {
        if (wanted_sheets && !wanted_sheets.includes(sheet.name)) {
            continue;
        }
        const parts = sheet.human_path.split("/").filter(Boolean);
        const svg_name = [project_name, ...parts].join("-") + ".svg";
        if (!sch_svgs.includes(svg_name)) {
            console.log(ts(), `skip    ${sheet.name}: no ${svg_name}`);
            continue;
        }

        const svg = readFileSync(join(svg_dir, "sch", svg_name), "utf8");
        const view = svg_size(svg);
        const h = Math.round((width * view.h) / view.w);

        const t = [Date.now()];
        await show_page(page, sheet.project_path, timeout_ms);
        t.push(Date.now());
        const kicanvas = await capture(page, "sch", view, width, h);
        t.push(Date.now());
        const kicad = await rasterize_svg(scratch, svg, width, h);
        t.push(Date.now());
        const r = await compare(scratch, kicad, kicanvas, "sch");
        t.push(Date.now());
        if (process.env["KICAD_COMPARE_TIMING"]) {
            console.log(
                "   timing ms (show, capture, rasterize, compare):",
                t.slice(1).map((v, i) => v - t[i]),
            );
        }

        const base = `sch-${slug(sheet.human_path == "/" ? "root" : sheet.human_path)}`;
        save_png(`${base}-kicad.png`, kicad);
        save_png(`${base}-kicanvas.png`, kicanvas);
        save_png(`${base}-diff.png`, r.diff);
        results.push({
            kind: "sheet",
            name: sheet.human_path,
            base,
            recall: r.recall,
            precision: r.precision,
        });
        console.log(
            ts(),
            `sheet   ${sheet.human_path.padEnd(40)} recall ${(r.recall * 100).toFixed(1).padStart(5)}%  precision ${(r.precision * 100).toFixed(1).padStart(5)}%`,
        );
    }

    // 3. Board layers.
    const board_page = await page.evaluate(
        () =>
            [...window.__kc.shell().project.pages()].find(
                (p) => p.type == "pcb",
            )?.project_path,
    );
    const edge_svg_name = pcb_svgs.find((f) => f.endsWith("-Edge_Cuts.svg"));

    if (opts.layers != "none" && board_page && edge_svg_name) {
        await prepare_capture(page, "pcb");
        await show_page(page, board_page, timeout_ms);

        const board = await page.evaluate(() => {
            const v = window.__kc.app("kc-board-app").viewer;
            const points = [];
            for (const d of v.board.drawings) {
                if (d.layer != "Edge.Cuts") continue;
                for (const k of ["start", "end", "mid"]) {
                    if (d[k]) points.push([d[k].x, d[k].y]);
                }
                for (const p of d.pts ?? []) {
                    if (p?.x !== undefined) points.push([p.x, p.y]);
                }
            }
            const bb = v.board.edge_cuts_bbox;
            return {
                points,
                bbox: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
                layers: [...v.layers.in_ui_order()].map((l) => l.name),
            };
        });

        const edge_svg = readFileSync(
            join(svg_dir, "pcb", edge_svg_name),
            "utf8",
        );
        const offset = find_offset(board.points, svg_points(edge_svg));
        if (!offset) {
            console.log(ts(), "board: couldn't align KiCad's plot, skipping");
        } else {
            const margin = 2;
            const box = {
                x: board.bbox.x - margin,
                y: board.bbox.y - margin,
                w: board.bbox.w + margin * 2,
                h: board.bbox.h + margin * 2,
            };
            const h = Math.round((width * box.h) / box.w);
            const svg_box = {
                x: box.x + offset[0],
                y: box.y + offset[1],
                w: box.w,
                h: box.h,
            };

            for (const svg_name of pcb_svgs) {
                const layer = svg_name
                    .slice(project_name.length + 1, -4)
                    .replace("_", ".");
                if (layer == "Edge.Cuts" || !board.layers.includes(layer)) {
                    continue;
                }
                const svg = readFileSync(
                    join(svg_dir, "pcb", svg_name),
                    "utf8",
                );
                const kicanvas = await capture(page, "pcb", box, width, h, {
                    layer,
                });
                const kicad = await rasterize_svg(
                    scratch,
                    frame_svg(svg, svg_box, width, h),
                    width,
                    h,
                );
                const r = await compare(scratch, kicad, kicanvas, "pcb");
                const base = `pcb-${slug(layer)}`;
                save_png(`${base}-kicad.png`, kicad);
                save_png(`${base}-kicanvas.png`, kicanvas);
                save_png(`${base}-diff.png`, r.diff);
                results.push({
                    kind: "layer",
                    name: layer,
                    base,
                    recall: r.recall,
                    precision: r.precision,
                    gap_recall: r.gap_recall,
                    gap_precision: r.gap_precision,
                });
                console.log(
                    ts(),
                    `layer   ${layer.padEnd(40)} recall ${(r.recall * 100).toFixed(1).padStart(5)}%  precision ${(r.precision * 100).toFixed(1).padStart(5)}%  gaps ${(r.gap_recall * 100).toFixed(1).padStart(5)}% / ${(r.gap_precision * 100).toFixed(1).padStart(5)}%`,
                );
            }
        }
    }
} catch (e) {
    console.log(ts(), `FAILED: ${e.stack ?? e.message}`);
    exit_code = 1;
} finally {
    await browser.close();
    await server.dispose();
}

// 4. Report.
const pct = (v) => `${(v * 100).toFixed(1)}%`;
writeFileSync(
    join(out_dir, "summary.json"),
    JSON.stringify({ project: project_name, tolerance, results }, null, 2),
);
const rows = results
    .map(
        (r) => `<tr>
    <td>${r.kind}</td><td>${r.name.replace(/</g, "&lt;")}</td>
    <td class="${r.recall < 0.95 ? "low" : ""}">${pct(r.recall)}</td>
    <td class="${r.precision < 0.95 ? "low" : ""}">${pct(r.precision)}</td>
    <td class="${(r.gap_recall ?? 1) < 0.95 ? "low" : ""}">${r.gap_recall === undefined ? "" : pct(r.gap_recall)}</td>
    <td class="${(r.gap_precision ?? 1) < 0.95 ? "low" : ""}">${r.gap_precision === undefined ? "" : pct(r.gap_precision)}</td>
    <td><a href="${r.base}-kicad.png">KiCad</a> ·
        <a href="${r.base}-kicanvas.png">KiCanvas</a> ·
        <a href="${r.base}-diff.png">diff</a></td>
    <td><a href="${r.base}-diff.png"><img src="${r.base}-diff.png" loading="lazy"></a></td>
</tr>`,
    )
    .join("\n");
writeFileSync(
    join(out_dir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>KiCad comparison: ${project_name}</title>
<style>
body{font:14px system-ui,sans-serif;margin:16px}
table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:middle}
td.low{background:#fde2e2}img{width:240px;display:block}
</style>
<h1>KiCad comparison: ${project_name}</h1>
<p>Recall: share of KiCad's drawing that KiCanvas also draws. Precision: share of
KiCanvas' drawing that KiCad also draws. For board layers, the gap columns do
the same for the empty space (clearances), which matters where copper pours
cover most of the board. KiCad's plots leave plated holes filled on inner
layers, so gap precision is a bit lower there. Within ${tolerance}px. In the
diffs, red is drawn only by KiCad, blue only by KiCanvas.</p>
<table><tr><th>Kind</th><th>Name</th><th>Recall</th><th>Precision</th><th>Gap recall</th><th>Gap precision</th><th>Images</th><th>Diff</th></tr>
${rows}
</table>`,
);

console.log(`\nReport: ${join(out_dir, "index.html")}`);
process.exit(exit_code);
