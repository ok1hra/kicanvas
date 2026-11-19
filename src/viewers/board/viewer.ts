/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox, Vec2 } from "../../base/math";
import { is_string } from "../../base/types";
import { Renderer } from "../../graphics";
import { WebGL2Renderer } from "../../graphics/webgl";
import type { BoardTheme } from "../../kicad";
import * as kicad_common from "../../kicad/common";
import * as board_items from "../../kicad/board";
import { DocumentViewer } from "../base/document-viewer";
import {
    KiCanvasLayersChangedEvent,
    KiCanvasNetSelectEvent,
} from "../base/events";
import { LayerNames, LayerSet, ViewLayer } from "./layers";
import { BoardPainter } from "./painter";

export type ContextMenuCallback = (
    screenX: number,
    screenY: number,
    items: Map<string, unknown>,
    onSelect: (item: unknown) => void,
) => void;

export class BoardViewer extends DocumentViewer<
    board_items.KicadPCB,
    BoardPainter,
    LayerSet,
    BoardTheme
> {
    #contextMenuCallback: ContextMenuCallback | null = null;

    get board(): board_items.KicadPCB {
        return this.document;
    }

    set contextMenuCallback(callback: ContextMenuCallback | null) {
        this.#contextMenuCallback = callback;
    }

    protected override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new WebGL2Renderer(canvas);
        return renderer;
    }

    protected override create_painter() {
        return new BoardPainter(this.renderer, this.layers, this.theme);
    }

    protected override create_layer_set() {
        return new LayerSet(this.board, this.theme);
    }

    protected override get grid_origin() {
        return this.board.setup?.grid_origin ?? new Vec2(0, 0);
    }

    protected override on_pick(
        mouse: Vec2,
        items: Generator<{ layer: ViewLayer; bbox: BBox }, void, unknown>,
    ): void {
        const selectableItems = new Map<string, unknown>();
        for (const { bbox } of items) {
            const item = bbox.context;
            if (item instanceof board_items.Footprint) {
                selectableItems.set(`Footprint: ${item.reference}`, item);
            } else if (kicad_common.isNetInfo(item)) {
                selectableItems.set(`Net: ${item.netname}`, item);
            } else {
                console.log(item);
            }
        }

        if (selectableItems.size === 0) {
            this.select(null);
        } else if (selectableItems.size === 1 || !this.#contextMenuCallback) {
            this.handleItemClick(selectableItems.values().next().value);
        } else {
            const { x, y } = this.viewport.camera.world_to_screen(mouse);
            this.#contextMenuCallback(x, y, selectableItems, (selected) => {
                this.handleItemClick(selected);
            });
        }
    }

    handleItemClick(item: unknown) {
        if (item instanceof board_items.Footprint) {
            this.select(item);
        } else if (kicad_common.isNetInfo(item)) {
            this.highlight_net(kicad_common.getNetNumber(item), true);
        }
    }

    #highlighted_net: number | null = null;

    /** The number of the highlighted net, if any. */
    get highlighted_net() {
        return this.#highlighted_net;
    }

    override select(item: board_items.Footprint | string | BBox | null) {
        this.#highlighted_net = null;
        // If item is a string, find the footprint by uuid or reference.
        if (is_string(item)) {
            item = this.board.find_footprint(item);
        }

        // If it's a footprint, use the footprint's nominal bounding box.
        if (item instanceof board_items.Footprint) {
            item = item.bbox;
        }

        super.select(item);
    }

    /**
     * Highlights a net (by number or name), replacing any selection.
     *
     * @param notify - whether to fire a KiCanvasNetSelectEvent. False when
     *     the highlight comes from cross-probing.
     */
    highlight_net(net: number | string | null, notify = false) {
        if (typeof net == "string") {
            net = this.board.net_by_name(net)?.number ?? null;
        }
        // Net 0 means "no net".
        this.#highlighted_net = net || null;
        this.set_selected_quietly(null);

        if (notify) {
            this.dispatchEvent(
                new KiCanvasNetSelectEvent({
                    net:
                        this.#highlighted_net === null
                            ? null
                            : this.board.get_netname_by_number(
                                  this.#highlighted_net,
                              ),
                }),
            );
        }
    }

    protected override paint_selected() {
        const highlighting = this.#highlighted_net !== null && !this.selected;
        this.#set_dimmed(highlighting);

        if (!highlighting) {
            super.paint_selected();
            return;
        }

        this.painter.paint_net(this.board, this.#highlighted_net!);
        // Draw the net on top of the dimmed board, like KiCad's net
        // highlighting.
        const graphics = this.layers.overlay.graphics;
        if (graphics) {
            graphics.composite_operation = "source-over";
        }
        this.draw();
    }

    #dimmed?: Map<ViewLayer, number | undefined>;

    /** Dims everything but the overlay, or restores the original opacity. */
    #set_dimmed(dim: boolean) {
        if (dim && !this.#dimmed) {
            this.#dimmed = new Map();
            for (const layer of this.layers.in_order()) {
                if (layer == this.layers.overlay) {
                    continue;
                }
                // Opacity is undefined unless something changed it.
                this.#dimmed.set(layer, layer.opacity);
                layer.opacity = (layer.opacity ?? 1) * 0.35;
            }
        } else if (!dim && this.#dimmed) {
            for (const [layer, opacity] of this.#dimmed) {
                layer.opacity = opacity!;
            }
            this.#dimmed = undefined;
        }
    }

    override paint() {
        // Painting creates new layers.
        this.#dimmed = undefined;
        super.paint();
    }

    private set_layers_opacity(layers: Generator<ViewLayer>, opacity: number) {
        for (const layer of layers) {
            layer.opacity = opacity;
        }
        this.draw();
    }

    set track_opacity(value: number) {
        this.set_layers_opacity(
            (this.layers as LayerSet).copper_layers(),
            value,
        );
    }

    set via_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).via_layers(), value);
    }

    set zone_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).zone_layers(), value);
    }

    set pad_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).pad_layers(), value);
    }

    set pad_hole_opacity(value: number) {
        this.set_layers_opacity(
            (this.layers as LayerSet).pad_hole_layers(),
            value,
        );
    }

    set grid_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).grid_layers(), value);
    }

    set page_opacity(value: number) {
        this.layers.by_name(LayerNames.drawing_sheet)!.opacity = value;
        this.draw();
    }

    /** Tells UI elements that layer visibility or zone fill changed. */
    notify_layers_changed() {
        this.dispatchEvent(new KiCanvasLayersChangedEvent());
    }

    /** Shows only the copper layers and the board outline. */
    show_copper_layers_only() {
        for (const layer of (this.layers as LayerSet).in_ui_order()) {
            layer.visible =
                layer.name.endsWith(".Cu") ||
                layer.name == LayerNames.edge_cuts;
        }
        this.draw();
        this.notify_layers_changed();
    }

    /** Whether zones are drawn filled (true) or as outlines only (false). */
    get zone_fills(): boolean {
        return (this.layers as LayerSet).show_zone_fills;
    }

    set zone_fills(value: boolean) {
        (this.layers as LayerSet).show_zone_fills = value;
        this.draw();
        this.notify_layers_changed();
    }

    /**
     * Zooms to fit the board outline (Edge.Cuts). Falls back to the page if
     * the board has no outline.
     */
    zoom_to_board() {
        // Prefer the board's own outline: footprints placed off the board
        // can have Edge.Cuts graphics too (e.g. connector cutouts).
        let board_bbox = this.board.edge_cuts_bbox;
        if (!board_bbox.valid) {
            board_bbox = this.layers.by_name(LayerNames.edge_cuts)!.bbox;
        }

        if (!board_bbox?.valid) {
            this.zoom_to_page();
            return;
        }

        this.viewport.camera.bbox = board_bbox.grow(
            Math.max(board_bbox.w, board_bbox.h) * 0.05,
        );
        this.draw();
    }

    protected override zoom_to_initial_view() {
        // Boards are frequently placed partially (or entirely) outside of the
        // drawing sheet, so showing the board outline is more useful than
        // showing the page.
        this.zoom_to_board();
    }
}
