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
import * as board_items from "../../kicad/board";
import { DocumentViewer } from "../base/document-viewer";
import {
    KiCanvasLayersChangedEvent,
    KiCanvasNetSelectEvent,
} from "../base/events";
import type { ChooserItem } from "../base/viewer";
import { LayerNames, LayerSet, ViewLayer } from "./layers";
import { BoardPainter } from "./painter";
import { pick_board, type BoardHit } from "./picking";

export class BoardViewer extends DocumentViewer<
    board_items.KicadPCB,
    BoardPainter,
    LayerSet,
    BoardTheme
> {
    get board(): board_items.KicadPCB {
        return this.document;
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

    /** Whether clicks select things; off while e.g. measuring. */
    picking_enabled = true;

    /**
     * Selects what was clicked: a footprint when clicking inside of its
     * courtyard, a net when clicking copper. When that's ambiguous (e.g. a
     * pad: its footprint or its net), a chooser menu is shown.
     */
    protected override on_pick(mouse: Vec2): void {
        if (!this.picking_enabled) {
            return;
        }
        const layers = this.layers as LayerSet;
        const hits = pick_board(this.board, mouse, {
            tolerance: Math.max(0.02, 3 / this.viewport.camera.zoom),
            flipped: this.viewport.camera.flipped,
            is_visible: (name) => !!layers.by_name(name)?.visible,
            zone_fills: this.zone_fills,
        });

        if (!hits.length) {
            this.select(null);
            return;
        }

        const items: ChooserItem<BoardHit>[] = hits.map((hit) =>
            hit.kind == "footprint"
                ? {
                      label: hit.footprint.reference,
                      detail: hit.footprint.value,
                      value: hit,
                  }
                : {
                      label: hit.name || `Net ${hit.net}`,
                      detail: `net · ${hit.what}`,
                      value: hit,
                  },
        );
        this.choose("Select", items, (hit) => {
            if (hit.kind == "footprint") {
                this.select(hit.footprint);
            } else {
                this.highlight_net(hit.net, true);
            }
        });
    }

    #highlighted_nets: number[] = [];

    /** The number of the (first) highlighted net, if any. */
    get highlighted_net(): number | null {
        return this.#highlighted_nets[0] ?? null;
    }

    /** Numbers of the highlighted nets. */
    get highlighted_nets(): readonly number[] {
        return this.#highlighted_nets;
    }

    #net_number(net: number | string): number | undefined {
        if (typeof net == "string") {
            return this.board.net_by_name(net)?.number;
        }
        return net;
    }

    /** Bounding box of everything drawn for nets (by number or name). */
    net_bbox(nets: number | string | (number | string)[]): BBox {
        const numbers = new Set(
            (Array.isArray(nets) ? nets : [nets])
                .map((n) => this.#net_number(n))
                .filter((n): n is number => n !== undefined),
        );
        const boxes: BBox[] = [];
        for (const layer of this.layers.in_order()) {
            for (const [item, bbox] of layer.bboxes) {
                const n = (item as { net?: unknown })?.net;
                const number =
                    typeof n == "number"
                        ? n
                        : (n as { number?: number } | undefined)?.number;
                if (number !== undefined && numbers.has(number)) {
                    boxes.push(bbox);
                }
            }
        }
        return BBox.combine(boxes);
    }

    /** The selected footprint, or else the highlighted nets. */
    override selection_bbox(): BBox | null {
        if (this.selected) {
            return this.selected;
        }
        if (this.#highlighted_nets.length) {
            const bbox = this.net_bbox(this.#highlighted_nets);
            return bbox.valid ? bbox : null;
        }
        return null;
    }

    override select(item: board_items.Footprint | string | BBox | null) {
        this.#highlighted_nets = [];
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
        this.highlight_nets(net === null ? [] : [net], notify);
    }

    /**
     * Highlights nets (by number or name), replacing any selection. Unknown
     * names are ignored.
     */
    highlight_nets(nets: (number | string)[], notify = false) {
        // Net 0 means "no net".
        this.#highlighted_nets = [
            ...new Set(
                nets
                    .map((n) => this.#net_number(n))
                    .filter((n): n is number => !!n),
            ),
        ];
        this.set_selected_quietly(null);

        if (notify) {
            const net = this.highlighted_net;
            this.dispatchEvent(
                new KiCanvasNetSelectEvent({
                    net:
                        net === null
                            ? null
                            : this.board.get_netname_by_number(net),
                }),
            );
        }
    }

    protected override paint_selected() {
        const highlighting =
            this.#highlighted_nets.length > 0 && !this.selected;
        this.#set_dimmed(highlighting);

        if (!highlighting) {
            super.paint_selected();
            return;
        }

        this.painter.paint_net(this.board, this.#highlighted_nets, () =>
            this.paint_annotations(),
        );
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
        // Painting creates new layers; keep which are shown (e.g. when the
        // view is flipped) and whether zones are filled.
        const old = this.layers as LayerSet | undefined;
        const visible = old
            ? new Map([...old.in_ui_order()].map((l) => [l.name, l.visible]))
            : undefined;
        const fills = old?.show_zone_fills;
        this.#dimmed = undefined;
        super.paint();
        const layers = this.layers as LayerSet;
        if (visible && layers) {
            for (const layer of layers.in_ui_order()) {
                const shown = visible.get(layer.name);
                if (shown !== undefined) {
                    layer.visible = shown;
                }
            }
            layers.show_zone_fills = fills!;
        }
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

    /** Layers shown by show_default_layers(), besides copper. */
    static default_layers: string[] = [
        LayerNames.edge_cuts,
        LayerNames.f_silks,
        LayerNames.b_silks,
        LayerNames.f_crtyd,
        LayerNames.b_crtyd,
    ];

    /**
     * Shows the copper layers, the board outline, and the silkscreen and
     * courtyards of both sides; hides the rest.
     */
    show_default_layers() {
        for (const layer of (this.layers as LayerSet).in_ui_order()) {
            layer.visible =
                layer.name.endsWith(".Cu") ||
                BoardViewer.default_layers.includes(layer.name);
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
