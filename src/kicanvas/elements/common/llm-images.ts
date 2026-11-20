/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { KicadPCB } from "../../../kicad";
import { KiCanvasLoadEvent } from "../../../viewers/base/events";
import type { LayerSet } from "../../../viewers/board/layers";
import { hierarchy_pages } from "../../compare/diff";
import type { ExportImage } from "../../llm-export";
import type { Project, ProjectPage } from "../../project";
import type { KCBoardViewerElement } from "../kc-board/viewer";
import type { KCSchematicViewerElement } from "../kc-schematic/viewer";

import "../kc-board/viewer";
import "../kc-schematic/viewer";

export type RenderedImage = ExportImage & { blob: Blob };

/** Image width in pixels: readable, and about what LLMs look at. */
const WIDTH = 2400;

const slug = (s: string) =>
    s
        .normalize("NFKD")
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "sheet";

function load_into(
    elm: KCSchematicViewerElement | KCBoardViewerElement,
    page: ProjectPage,
) {
    return new Promise<void>((resolve) => {
        const once = elm.viewer.addEventListener(KiCanvasLoadEvent.type, () => {
            once.dispose();
            resolve();
        });
        elm.load(page);
    });
}

const pause = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** A viewer element of a given size in pixels, out of sight. */
async function offscreen_viewer<
    T extends HTMLElement & { ready: PromiseLike<unknown> },
>(tag: string, width: number, height: number) {
    const dpr = window.devicePixelRatio || 1;
    const box = document.createElement("div");
    box.style.cssText = `position: fixed; left: 0; top: 0; z-index: -1; visibility: hidden; pointer-events: none; width: ${width / dpr}px; height: ${height / dpr}px;`;
    const elm = document.createElement(tag) as T;
    elm.style.cssText = "display: block; width: 100%; height: 100%;";
    box.append(elm);
    document.body.append(box);
    await elm.ready;
    return { elm, box };
}

function canvas_png(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("No image"))),
            "image/png",
        ),
    );
}

/**
 * Renders each schematic sheet, the board's top and bottom, and each copper
 * layer to PNG, with KiCanvas' default (light) schematic colors.
 */
export async function render_llm_images(
    project: Project,
    board: KicadPCB | undefined,
    progress: (done: number, total: number) => void,
): Promise<RenderedImage[]> {
    const images: RenderedImage[] = [];
    const pages = hierarchy_pages(project);
    const board_page = [...project.pages()].find((p) => p.type == "pcb");
    const copper = board
        ? board.layers
              .map((l) => l.canonical_name)
              .filter((n) => n.endsWith(".Cu"))
        : [];
    const total = pages.length + (board_page ? 2 + copper.length : 0);
    let done = 0;
    progress(done, total);

    if (pages.length) {
        // A landscape page, like most sheets.
        const { elm, box } = await offscreen_viewer<KCSchematicViewerElement>(
            "kc-schematic-viewer",
            WIDTH,
            Math.round(WIDTH / Math.SQRT2),
        );
        try {
            for (const page of pages) {
                await load_into(elm, page);
                const viewer = elm.viewer;
                viewer.zoom_to_page();
                await pause(30);
                viewer.render_now();
                const name =
                    page.sheet?.sheetname ?? page.name ?? page.filename;
                const number = (page.page ?? "1").padStart(2, "0");
                images.push({
                    name: `images/sheet-${number}-${slug(name)}.png`,
                    caption: `schematic sheet ${page.page ?? "1"} “${name}” (${project.human_sheet_path(page.sheet_path)}, ${page.filename})`,
                    blob: await canvas_png(viewer.canvas),
                });
                progress(++done, total);
            }
        } finally {
            box.remove();
        }
    }

    if (board && board_page) {
        const outline = board.edge_cuts_bbox;
        const ratio = outline.valid ? outline.h / outline.w : 0.75;
        const height = Math.round(
            Math.min(WIDTH * 1.5, Math.max(WIDTH * 0.4, WIDTH * ratio)),
        );
        const { elm, box } = await offscreen_viewer<KCBoardViewerElement>(
            "kc-board-viewer",
            WIDTH,
            height,
        );
        try {
            await load_into(elm, board_page);
            const viewer = elm.viewer;
            viewer.zone_fills = false;
            const views: {
                name: string;
                caption: string;
                layers: string[];
                flipped: boolean;
            }[] = [
                {
                    name: "images/board-top.png",
                    caption:
                        "the board from the top: front copper, silkscreen and fabrication layers (with references) and the outline",
                    layers: ["F.Cu", "F.SilkS", "F.Fab", "Edge.Cuts"],
                    flipped: false,
                },
                {
                    name: "images/board-bottom.png",
                    caption:
                        "the board from the bottom (mirrored, as seen from below): back copper, silkscreen and fabrication layers and the outline",
                    layers: ["B.Cu", "B.SilkS", "B.Fab", "Edge.Cuts"],
                    flipped: true,
                },
                ...copper.map((layer) => ({
                    name: `images/copper-${slug(layer)}.png`,
                    caption: `copper layer ${layer} (tracks, pads and zone outlines) with the board outline, from the top`,
                    layers: [layer, "Edge.Cuts"],
                    flipped: false,
                })),
            ];
            for (const view of views) {
                if (viewer.viewport.camera.flipped != view.flipped) {
                    viewer.flip_view();
                }
                for (const layer of (viewer.layers as LayerSet).in_ui_order()) {
                    layer.visible = view.layers.includes(layer.name);
                }
                if (outline.valid) {
                    viewer.viewport.camera.bbox = outline
                        .copy()
                        .grow(Math.max(outline.w, outline.h) * 0.02);
                } else {
                    viewer.zoom_to_board();
                }
                await pause(30);
                viewer.render_now();
                images.push({
                    name: view.name,
                    caption: view.caption,
                    blob: await canvas_png(viewer.canvas),
                });
                progress(++done, total);
            }
        } finally {
            box.remove();
        }
    }

    return images;
}
