/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { first } from "../../base/iterator";
import { BBox, Vec2 } from "../../base/math";
import { is_string } from "../../base/types";
import { Circle, Polyline, Renderer } from "../../graphics";
import { Canvas2DRenderer } from "../../graphics/canvas2d";
import type { SchematicTheme } from "../../kicad";
import {
    KicadSch,
    SchematicSheet,
    SchematicSymbol,
} from "../../kicad/schematic";
import type { ProjectPage } from "../../kicanvas/project";
import { DocumentViewer } from "../base/document-viewer";
import { later } from "../../base/async";
import { KiCanvasActivateEvent, KiCanvasNetSelectEvent } from "../base/events";
import type { ChooserItem } from "../base/viewer";
import { ViewLayerNames, type ViewLayerSet } from "../base/view-layers";
import {
    SheetConnectivity,
    type BusAliases,
    type SheetBus,
    type SheetNet,
} from "./connectivity";
import { LayerSet } from "./layers";
import { SchematicPainter, image_loaded_event } from "./painter";

export class SchematicViewer extends DocumentViewer<
    KicadSch,
    SchematicPainter,
    LayerSet,
    SchematicTheme
> {
    get schematic(): KicadSch {
        return this.document;
    }

    /** Connectivity of the shown sheet. */
    get connectivity(): SheetConnectivity {
        return SheetConnectivity.for(this.schematic);
    }

    #highlighted_nets: SheetNet[] = [];
    #highlighted_buses: SheetBus[] = [];

    /** Bus aliases of the project, see Project.bus_aliases. */
    bus_aliases: BusAliases = new Map();

    /** The highlighted nets on the current sheet. */
    get highlighted_nets(): readonly SheetNet[] {
        return this.#highlighted_nets;
    }

    /** The highlighted buses on the current sheet. */
    get highlighted_buses(): readonly SheetBus[] {
        return this.#highlighted_buses;
    }

    /**
     * Highlights nets (and buses) on the current sheet, replacing any
     * selection except of a sheet symbol, which can stay selected.
     *
     * @param notify - whether to fire a KiCanvasNetSelectEvent. False when
     *     the highlight comes from cross-probing.
     */
    highlight_nets(nets: SheetNet[], notify = false, buses: SheetBus[] = []) {
        this.#highlighted_nets = nets;
        this.#highlighted_buses = buses;
        if (this.selected?.context instanceof SchematicSheet) {
            later(() => this.paint_selected());
        } else {
            this.set_selected_quietly(null);
        }
        if (notify) {
            this.dispatchEvent(
                new KiCanvasNetSelectEvent({ net: nets[0] ?? null, nets }),
            );
        }
    }

    /**
     * Highlights bus members (or all of them) and tells listeners which
     * member nets were picked: also those that aren't on this sheet.
     */
    #pick_bus_members(bus: SheetBus, members: string[]) {
        const wanted = new Set(members);
        const nets = this.connectivity.nets.filter((net) =>
            net.labels.some((l) => wanted.has(l.text)),
        );
        this.#highlighted_nets = nets;
        this.#highlighted_buses = [bus];
        this.set_selected_quietly(null);
        this.dispatchEvent(
            new KiCanvasNetSelectEvent({
                net: nets[0] ?? null,
                nets,
                members,
            }),
        );
    }

    protected override on_pick(
        mouse: Vec2,
        items: ReturnType<ViewLayerSet["query_point"]>,
    ) {
        // Wires, pins and labels select their net, buses let you choose
        // their nets. Allow a few pixels of slop, but at least a quarter
        // millimeter.
        const tolerance = Math.max(0.25, 5 / this.viewport.camera.zoom);
        const { net, bus } = this.document
            ? this.connectivity.item_at(mouse, tolerance)
            : {};

        if (net) {
            this.highlight_nets([net], true);
            return;
        }

        if (bus) {
            const members = bus.members(this.bus_aliases);
            const name = bus.names[0] ?? "Bus";
            const items: ChooserItem<string[]>[] = [
                {
                    label: "ALL",
                    detail: `${members.length} nets`,
                    value: members,
                },
                ...members.map((m) => ({ label: m, value: [m] })),
            ];
            this.choose(name, items, (chosen) =>
                this.#pick_bus_members(bus, chosen),
            );
            return;
        }

        // Selecting a sheet symbol keeps the highlighted net, so that it
        // can be followed into the sheet. Clicks anywhere on the sheet
        // symbol (e.g. on its name) select it.
        const hits = [...items];
        const sheet = hits.find(
            (h) => h.bbox.context instanceof SchematicSheet,
        );
        if (sheet && !(hits[0]?.bbox.context instanceof SchematicSymbol)) {
            this.select(sheet.bbox);
            return;
        }
        this.#highlighted_nets = [];
        this.#highlighted_buses = [];
        this.select(hits[0]?.bbox ?? null);
    }

    /** Double clicks open sheets, wherever on the sheet symbol. */
    protected override on_activate(
        mouse: Vec2,
        items: ReturnType<ViewLayerSet["query_point"]>,
    ) {
        for (const { bbox } of items) {
            if (bbox.context instanceof SchematicSheet) {
                this.dispatchEvent(
                    new KiCanvasActivateEvent({ item: bbox.context }),
                );
                return;
            }
        }
    }

    override select(
        item: SchematicSymbol | SchematicSheet | string | BBox | null,
    ) {
        const sheet =
            item instanceof SchematicSheet ||
            (item instanceof BBox && item.context instanceof SchematicSheet);
        if (!sheet) {
            this.#highlighted_nets = [];
            this.#highlighted_buses = [];
        }
        this.#select(item);
    }

    protected override paint_selected() {
        const highlighting =
            this.#highlighted_nets.length || this.#highlighted_buses.length;
        if (!highlighting) {
            super.paint_selected();
            return;
        }

        const layer = this.layers.overlay;
        layer.clear();
        this.renderer.start_layer(layer.name);

        const color = this.theme.brightened;
        const glow = color.with_alpha(0.35);

        for (const net of this.#highlighted_nets) {
            for (const wire of net.wires) {
                this.renderer.line(new Polyline(wire.pts, 0.8, glow));
                this.renderer.line(new Polyline(wire.pts, 0.25, color));
            }
            for (const pin of net.pins) {
                this.renderer.line(
                    new Polyline([pin.position, pin.end], 0.8, glow),
                );
                this.renderer.circle(new Circle(pin.position, 0.5, color));
            }
            for (const label of net.labels) {
                this.renderer.circle(new Circle(label.at.position, 0.7, color));
            }
            for (const pin of net.sheet_pins) {
                this.renderer.circle(new Circle(pin.at.position, 0.7, color));
            }
        }

        for (const bus of this.#highlighted_buses) {
            for (const wire of bus.wires) {
                this.renderer.line(new Polyline(wire.pts, 1.2, glow));
                this.renderer.line(new Polyline(wire.pts, 0.45, color));
            }
            for (const entry of bus.entries) {
                const pts = [
                    entry.at.position,
                    entry.at.position.add(entry.size),
                ];
                this.renderer.line(new Polyline(pts, 0.8, glow));
                this.renderer.line(new Polyline(pts, 0.25, color));
            }
            for (const label of bus.labels) {
                this.renderer.circle(new Circle(label.at.position, 0.8, color));
            }
            for (const pin of bus.sheet_pins) {
                this.renderer.circle(new Circle(pin.at.position, 0.8, color));
            }
        }

        this.paint_annotations();

        // A selected sheet symbol stays selected.
        const selected = this.selected;
        if (selected) {
            const bb = selected.copy().grow(selected.w * 0.1);
            this.renderer.line(Polyline.from_BBox(bb, 0.254, color));
        }

        layer.graphics = this.renderer.end_layer();
        this.draw();
    }

    override async setup() {
        await super.setup();
        // Redraw once images in the schematic finish decoding.
        const redraw = () => this.draw();
        window.addEventListener(image_loaded_event, redraw);
        this.disposables.add({
            dispose: () =>
                window.removeEventListener(image_loaded_event, redraw),
        });
    }

    override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new Canvas2DRenderer(canvas);
        renderer.state.fill = this.theme.note;
        renderer.state.stroke = this.theme.note;
        renderer.state.stroke_width = 0.1524;
        return renderer;
    }

    override async load(src: KicadSch | ProjectPage) {
        if (src instanceof KicadSch) {
            return await super.load(src);
        }

        this.document = null!;
        this.#highlighted_nets = [];
        this.#highlighted_buses = [];
        this.bus_aliases = src.project.bus_aliases;

        const doc = src.document as KicadSch;
        doc.update_hierarchical_data(src.sheet_path);

        return await super.load(doc);
    }

    /**
     * Zooms so that everything drawn on the sheet (but not the drawing sheet
     * border and title block) fills the view.
     */
    zoom_to_content() {
        const skip = [
            ViewLayerNames.drawing_sheet,
            ViewLayerNames.grid,
            ViewLayerNames.overlay,
        ] as string[];
        const boxes = [];
        for (const layer of this.layers.in_order()) {
            if (skip.includes(layer.name)) {
                continue;
            }
            const bbox = layer.bbox;
            if (bbox.valid) {
                boxes.push(bbox);
            }
        }

        if (!boxes.length) {
            this.zoom_to_page();
            return;
        }

        const bbox = BBox.combine(boxes);
        this.viewport.camera.bbox = bbox.grow(Math.max(bbox.w, bbox.h) * 0.02);
        this.draw();
    }

    protected override zoom_to_initial_view() {
        this.zoom_to_content();
    }

    protected override create_painter() {
        return new SchematicPainter(this.renderer, this.layers, this.theme);
    }

    protected override create_layer_set() {
        return new LayerSet(this.theme);
    }

    #select(
        item: SchematicSymbol | SchematicSheet | string | BBox | null,
    ): void {
        // If item is a string, find the symbol by uuid or reference.
        if (is_string(item)) {
            item =
                this.schematic.find_symbol(item) ??
                this.schematic.find_sheet(item);
        }

        // If it's a symbol or sheet, find the bounding box for it.
        if (item instanceof SchematicSymbol || item instanceof SchematicSheet) {
            const bboxes = this.layers.query_item_bboxes(item);
            item = first(bboxes) ?? null;
        }

        super.select(item);
    }
}
