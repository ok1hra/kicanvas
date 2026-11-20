/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Barrier, later } from "../../base/async";
import { Disposables, type IDisposable } from "../../base/disposable";
import { listen } from "../../base/events";
import { no_self_recursion } from "../../base/functions";
import { BBox, Vec2 } from "../../base/math";
import { Color, Polygon, Polyline, Renderer } from "../../graphics";
import {
    KiCanvasActivateEvent,
    KiCanvasLoadEvent,
    KiCanvasMouseMoveEvent,
    KiCanvasSelectEvent,
    KiCanvasSelectionEvent,
    KiCanvasViewportEvent,
    type KiCanvasEventMap,
} from "./events";
import { ViewLayerSet } from "./view-layers";
import { Viewport } from "./viewport";

/** A box drawn over the document, see Viewer.annotations. */
export type Annotation = {
    bbox: BBox;
    color: Color;
    /** Fill, usually a transparent color */
    fill?: Color;
    /** Line width, in mm */
    width?: number;
    /** Space around the box, in mm */
    margin?: number;
};

/** An entry of a chooser menu, see Viewer.chooser. */
export type ChooserItem<T = unknown> = {
    label: string;
    /** Shown dimmed after the label */
    detail?: string;
    value: T;
};

export type ChooserCallback = (
    client_x: number,
    client_y: number,
    title: string,
    items: ChooserItem[],
    on_choose: (value: unknown) => void,
) => void;

export abstract class Viewer extends EventTarget {
    public renderer: Renderer;
    public viewport: Viewport;
    public layers: ViewLayerSet;
    public mouse_position: Vec2 = new Vec2(0, 0);
    public loaded = new Barrier();

    protected disposables = new Disposables();
    protected setup_finished = new Barrier();

    #selected: BBox | null;

    constructor(
        public canvas: HTMLCanvasElement,
        protected interactive = true,
    ) {
        super();
    }

    dispose() {
        this.disposables.dispose();
    }

    override addEventListener<K extends keyof KiCanvasEventMap>(
        type: K,
        listener:
            | ((this: Viewer, ev: KiCanvasEventMap[K]) => void)
            | { handleEvent: (ev: KiCanvasEventMap[K]) => void }
            | null,
        options?: boolean | AddEventListenerOptions,
    ): IDisposable;
    override addEventListener(
        type: string,
        listener: EventListener | null,
        options?: boolean | AddEventListenerOptions,
    ): IDisposable {
        super.addEventListener(type, listener, options);
        return {
            dispose: () => {
                this.removeEventListener(type, listener, options);
            },
        };
    }

    protected abstract create_renderer(canvas: HTMLCanvasElement): Renderer;

    async setup() {
        this.renderer = this.disposables.add(this.create_renderer(this.canvas));

        await this.renderer.setup();

        this.viewport = this.disposables.add(
            new Viewport(this.renderer, () => {
                this.on_viewport_change();
            }),
        );

        if (this.interactive) {
            this.viewport.enable_pan_and_zoom(0.5, 190);

            this.disposables.add(
                listen(this.canvas, "mousemove", (e) => {
                    this.on_mouse_change(e);
                }),
            );

            this.disposables.add(
                listen(this.canvas, "panzoom", (e) => {
                    this.on_mouse_change(e as MouseEvent);
                }),
            );

            this.disposables.add(
                listen(this.canvas, "click", (e) => {
                    // The camera can have moved since the last mouse move.
                    this.on_mouse_change(e);
                    this.last_click = { x: e.clientX, y: e.clientY };
                    const items = this.layers.query_point(this.mouse_position);
                    this.on_pick(this.mouse_position, items);
                }),
            );

            this.disposables.add(
                listen(this.canvas, "dblclick", (e) => {
                    this.on_mouse_change(e);
                    const items = this.layers.query_point(this.mouse_position);
                    this.on_activate(this.mouse_position, items);
                }),
            );
        }

        this.setup_finished.open();
    }

    /** Where the last click was, in client (window) coordinates. */
    last_click = { x: 0, y: 0 };

    /**
     * Shows a small menu at the last click to choose between items, e.g.
     * overlapping parts and nets, or the nets of a bus. Set by the UI;
     * without it, the first item is chosen.
     */
    chooser: ChooserCallback | null = null;

    /** Lets the user choose one of the items; see chooser. */
    protected choose<T>(
        title: string,
        items: ChooserItem<T>[],
        on_choose: (value: T) => void,
    ) {
        if (!items.length) {
            return;
        }
        if (items.length == 1 || !this.chooser) {
            on_choose(items[0]!.value);
            return;
        }
        this.chooser(
            this.last_click.x,
            this.last_click.y,
            title,
            items,
            on_choose as (value: unknown) => void,
        );
    }

    /** Handles a double click: fires a KiCanvasActivateEvent. */
    protected on_activate(
        mouse: Vec2,
        items: ReturnType<ViewLayerSet["query_point"]>,
    ) {
        for (const { bbox } of items) {
            this.dispatchEvent(
                new KiCanvasActivateEvent({ item: bbox.context }),
            );
            return;
        }
    }

    protected on_viewport_change() {
        if (this.interactive) {
            this.draw();
        }
        this.dispatchEvent(new KiCanvasViewportEvent());
    }

    protected on_mouse_change(e: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const new_position = this.viewport.camera.screen_to_world(
            new Vec2(e.clientX - rect.left, e.clientY - rect.top),
        );

        if (
            this.mouse_position.x != new_position.x ||
            this.mouse_position.y != new_position.y
        ) {
            this.mouse_position.set(new_position);
            this.dispatchEvent(new KiCanvasMouseMoveEvent(this.mouse_position));
        }
    }

    public abstract load(src: any): Promise<void>;

    protected resolve_loaded(value: boolean) {
        if (value) {
            this.loaded.open();
            this.dispatchEvent(new KiCanvasLoadEvent());
        }
    }

    public abstract paint(): void;

    protected on_draw() {
        this.renderer.clear_canvas();

        if (!this.layers) {
            return;
        }

        // Render all layers in display order (back to front)
        let depth = 0.01;
        const camera = this.viewport.camera.matrix;
        const should_dim = this.layers.is_any_layer_highlighted();

        // TODO: donot flip drawing sheet and grid

        for (const layer of this.layers.in_display_order()) {
            if (layer.visible && layer.graphics) {
                let alpha = layer.opacity;

                if (should_dim && !layer.highlighted) {
                    alpha = 0.25;
                }

                layer.graphics.render(camera, depth, alpha);
                depth += 0.01;
            }
        }
    }

    public draw() {
        if (!this.viewport) {
            return;
        }

        window.requestAnimationFrame(() => {
            this.on_draw();
        });
    }

    protected on_pick(
        mouse: Vec2,
        items: ReturnType<ViewLayerSet["query_point"]>,
    ) {
        let selected = null;

        for (const { bbox } of items) {
            selected = bbox;
            break;
        }

        this.select(selected);
    }

    public select(item: BBox | null) {
        this.selected = item;
    }

    /**
     * Changes the selection without firing a select event, used when the
     * selection is driven from elsewhere (e.g. cross-probing).
     */
    protected set_selected_quietly(bb: BBox | null) {
        this.#quiet = true;
        try {
            this.selected = bb;
        } finally {
            this.#quiet = false;
        }
    }

    #quiet = false;

    /**
     * Zooms to an item and some of its surroundings, so that it can be seen
     * in context. Counts as the user moving the camera.
     *
     * @param bbox - the item's bounding box
     */
    zoom_to_item(bbox: BBox) {
        const size = Math.max(bbox.w, bbox.h);
        // Between 15 and 40mm around the item, depending on its size.
        const margin = Math.min(40, Math.max(15, size));
        this.viewport.camera.bbox = bbox.grow(margin);
        this.viewport.user_moved_camera = true;
        this.draw();
    }

    /**
     * Moves the camera so that the given box is in view, zooming out if it
     * doesn't fit. Counts as the user moving the camera.
     */
    ensure_visible(bbox: BBox) {
        const camera = this.viewport.camera;
        const view = camera.bbox;
        const target = bbox.grow(Math.max(bbox.w, bbox.h) * 0.25 + 1);

        const inside =
            target.x >= view.x &&
            target.y >= view.y &&
            target.x2 <= view.x2 &&
            target.y2 <= view.y2;

        if (!inside) {
            if (target.w > view.w || target.h > view.h) {
                camera.bbox = target;
            } else {
                camera.center.set(target.center);
            }
            this.viewport.user_moved_camera = true;
            this.draw();
        }
    }

    public get selected(): BBox | null {
        return this.#selected;
    }

    public set selected(bb: BBox | null) {
        this._set_selected(bb);
    }

    @no_self_recursion
    private _set_selected(bb: BBox | null) {
        const previous = this.#selected;
        this.#selected = bb?.copy() || null;

        // Notify event listeners
        if (!this.#quiet) {
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: this.#selected?.context,
                    previous: previous?.context,
                }),
            );
        }

        later(() => this.paint_selected());
        this.notify_selection();
    }

    /** Fires a KiCanvasSelectionEvent. */
    protected notify_selection() {
        this.dispatchEvent(new KiCanvasSelectionEvent());
    }

    /**
     * Where what's selected or highlighted is, or null if nothing is. See
     * "fit to selection".
     */
    selection_bbox(): BBox | null {
        return this.selected;
    }

    public get selection_color() {
        return Color.white;
    }

    protected paint_selected() {
        const layer = this.layers.overlay;

        layer.clear();

        const annotated = this.#annotations.length > 0;
        if (this.#selected || annotated) {
            this.renderer.start_layer(layer.name);

            if (this.#selected) {
                const bb = this.#selected.copy().grow(this.#selected.w * 0.1);
                this.renderer.line(
                    Polyline.from_BBox(bb, 0.254, this.selection_color),
                );
                // The fill would wash out the annotations' colors.
                if (!annotated) {
                    this.renderer.polygon(
                        Polygon.from_BBox(bb, this.selection_color),
                    );
                }
            }
            this.paint_annotations();

            layer.graphics = this.renderer.end_layer();
            layer.graphics.composite_operation = annotated
                ? "source-over"
                : "overlay";
        }

        this.draw();
    }

    #annotations: Annotation[] = [];

    /**
     * Boxes drawn over the document, e.g. to mark what changed between two
     * revisions.
     */
    get annotations(): readonly Annotation[] {
        return this.#annotations;
    }

    set annotations(list: Annotation[]) {
        this.#annotations = list;
        later(() => this.paint_selected());
    }

    /** Draws the annotations; call between start_layer and end_layer. */
    protected paint_annotations() {
        for (const a of this.#annotations) {
            const bb = a.bbox.copy().grow(a.margin ?? 0.5);
            if (a.fill) {
                this.renderer.polygon(Polygon.from_BBox(bb, a.fill));
            }
            this.renderer.line(
                Polyline.from_BBox(bb, a.width ?? 0.25, a.color),
            );
        }
    }

    abstract zoom_to_page(): void;

    zoom_to_selection() {
        if (!this.selected) {
            return;
        }
        this.viewport.camera.bbox = this.selected.grow(10);
        this.draw();
    }

    flip_view() {
        const flip = !this.viewport.camera.flipped;

        this.viewport.camera.flipped = flip;

        for (const layer of this.layers.in_order()) {
            if (layer.graphics) {
                layer.graphics.renderer.state.flipped = flip;
            }
        }

        // We need redraw some items because some items are not flippable
        // TODO: it re-paint all items and is inefficient
        this.paint();
        this.draw();
    }
}
