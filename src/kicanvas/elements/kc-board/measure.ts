/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox, Vec2 } from "../../../base/math";
import { css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import {
    Arc,
    Circle,
    GrLine,
    GrRect,
    type KicadPCB,
} from "../../../kicad/board";
import { KiCanvasLoadEvent } from "../../../viewers/base/events";
import { LayerNames } from "../../../viewers/board/layers";
import type { BoardViewer } from "../../../viewers/board/viewer";

type Segment = [Vec2, Vec2];
type Snap = { point: Vec2; kind: "center" | "edge" | "free" };

/** Snap radius, in screen pixels */
const snap_radius = 10;

function nearest_on_segment(p: Vec2, a: Vec2, b: Vec2) {
    const ab = b.sub(a);
    const len2 = ab.x * ab.x + ab.y * ab.y;
    const t = len2
        ? Math.max(
              0,
              Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2),
          )
        : 0;
    return new Vec2(a.x + ab.x * t, a.y + ab.y * t);
}

function bbox_edges(bb: BBox): Segment[] {
    const tl = new Vec2(bb.x, bb.y);
    const tr = new Vec2(bb.x2, bb.y);
    const br = new Vec2(bb.x2, bb.y2);
    const bl = new Vec2(bb.x, bb.y2);
    return [
        [tl, tr],
        [tr, br],
        [br, bl],
        [bl, tl],
    ];
}

/**
 * Points and edges to snap to: centers of holes and pads, and the edges of
 * pads, tracks and the board outline.
 */
class SnapTargets {
    /** Hole centers, which take precedence */
    holes: Vec2[] = [];
    /** Pad centers and circle centers */
    centers: Vec2[] = [];
    edges: Segment[] = [];

    constructor(viewer: BoardViewer) {
        const layers = viewer.layers;
        const centers_of = (name: string, into: Vec2[]) => {
            for (const bb of layers.by_name(name)?.bboxes.values() ?? []) {
                into.push(bb.center);
            }
        };
        centers_of(LayerNames.pad_holes, this.holes);
        centers_of(LayerNames.via_holes, this.holes);
        centers_of(LayerNames.non_plated_holes, this.holes);
        centers_of(LayerNames.pads_front, this.centers);
        centers_of(LayerNames.pads_back, this.centers);

        for (const name of [LayerNames.pads_front, LayerNames.pads_back]) {
            for (const bb of layers.by_name(name)?.bboxes.values() ?? []) {
                this.edges.push(...bbox_edges(bb));
            }
        }

        this.#add_tracks(viewer.board);
        this.#add_outline(viewer.board);
    }

    #add_tracks(board: KicadPCB) {
        for (const s of board.segments) {
            const seg = s as { start?: Vec2; end?: Vec2; width?: number };
            if (!seg.start || !seg.end || !seg.width) {
                continue;
            }
            const dir = seg.end.sub(seg.start);
            const len = dir.magnitude;
            if (!len) {
                continue;
            }
            // The two long edges of the track.
            const n = new Vec2(-dir.y / len, dir.x / len).multiply(
                seg.width / 2,
            );
            this.edges.push(
                [seg.start.add(n), seg.end.add(n)],
                [seg.start.sub(n), seg.end.sub(n)],
            );
        }
    }

    #add_outline(board: KicadPCB) {
        for (const d of board.drawings) {
            if (d.layer != LayerNames.edge_cuts) {
                continue;
            }
            if (d instanceof GrLine) {
                this.edges.push([d.start, d.end]);
            } else if (d instanceof GrRect) {
                this.edges.push(
                    ...bbox_edges(BBox.from_points([d.start, d.end])),
                );
            } else if (d instanceof Arc) {
                const pts = d.arc.to_polyline();
                for (let i = 0; i < pts.length - 1; i++) {
                    this.edges.push([pts[i]!, pts[i + 1]!]);
                }
            } else if (d instanceof Circle) {
                this.centers.push(d.center);
                const r = d.end.sub(d.center).magnitude;
                const steps = 48;
                for (let i = 0; i < steps; i++) {
                    const a = (i / steps) * Math.PI * 2;
                    const b = ((i + 1) / steps) * Math.PI * 2;
                    this.edges.push([
                        d.center.add(
                            new Vec2(Math.cos(a) * r, Math.sin(a) * r),
                        ),
                        d.center.add(
                            new Vec2(Math.cos(b) * r, Math.sin(b) * r),
                        ),
                    ]);
                }
            }
        }
    }

    /**
     * The best snap point near p, within radius (world units): a hole
     * center, then (closer in) a pad center, then an edge.
     */
    snap(p: Vec2, radius: number): Snap {
        const nearest = (points: Vec2[], r: number) => {
            let best: Vec2 | undefined;
            let best_d = r;
            for (const c of points) {
                const d = c.sub(p).magnitude;
                if (d < best_d) {
                    best = c;
                    best_d = d;
                }
            }
            return best;
        };

        const center =
            nearest(this.holes, radius) ?? nearest(this.centers, radius * 0.6);
        if (center) {
            return { point: center, kind: "center" };
        }

        let best: Vec2 | undefined;
        let best_d = radius;

        best_d = radius;
        for (const [a, b] of this.edges) {
            const q = nearest_on_segment(p, a, b);
            const d = q.sub(p).magnitude;
            if (d < best_d) {
                best = q;
                best_d = d;
            }
        }
        if (best) {
            return { point: best, kind: "edge" };
        }

        return { point: p, kind: "free" };
    }
}

/**
 * Measures distances and angles on the board. Click a start and an end
 * point; points snap to hole/pad centers and to edges of pads, tracks and
 * the board outline. Shift limits the measurement to horizontal or
 * vertical.
 */
export class KCBoardMeasureElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                position: absolute;
                inset: 0;
                z-index: 5;
                pointer-events: none;
                display: none;
            }

            :host([active]) {
                display: block;
            }

            svg {
                width: 100%;
                height: 100%;
                overflow: visible;
            }

            .line {
                stroke: #ffd60a;
                stroke-width: 1.5;
            }

            .leg {
                stroke: #ffd60a;
                stroke-width: 1;
                stroke-dasharray: 4 3;
                opacity: 0.7;
            }

            .end {
                fill: #ffd60a;
            }

            .snap {
                fill: none;
                stroke: #00e0ff;
                stroke-width: 1.5;
            }

            .label rect {
                fill: rgba(30, 30, 32, 0.92);
                stroke: #ffd60a;
                stroke-width: 1;
            }

            .label text {
                fill: #f0f0f0;
                font:
                    12px system-ui,
                    sans-serif;
            }

            .label .main {
                font-weight: 700;
                font-size: 13px;
            }
        `,
    ];

    static change_event = "kicanvas:measure-change";

    viewer: BoardViewer;

    #active = false;
    #start?: Vec2;
    #end?: Vec2;
    #finished = false;
    #snap?: Snap;
    #shift = false;
    #targets?: SnapTargets;
    #frame = 0;

    get active() {
        return this.#active;
    }

    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;
            super.connectedCallback();
        })();
    }

    override initialContentCallback() {
        const canvas = this.viewer.canvas;

        // The board changed: the snap targets need to be rebuilt.
        this.addDisposable(
            this.viewer.addEventListener(KiCanvasLoadEvent.type, () => {
                this.#targets = undefined;
            }),
        );

        const on_move = (e: MouseEvent) => {
            if (!this.#active) return;
            this.#shift = e.shiftKey;
            this.#track();
        };
        const on_click = (e: MouseEvent) => {
            if (!this.#active || e.button != 0) return;
            this.#shift = e.shiftKey;
            this.#track();
            const point = this.#current_point();
            if (!this.#start || this.#finished) {
                this.#start = point;
                this.#end = point;
                this.#finished = false;
            } else {
                this.#end = point;
                this.#finished = true;
            }
            this.#notify();
        };
        const on_key = (e: KeyboardEvent) => {
            const typing = (e.composedPath()[0] as Element)?.closest?.(
                "input, textarea",
            );
            if (typing) return;
            if (e.key == "Shift" && this.#active) {
                this.#shift = e.type == "keydown";
            }
            if (e.type != "keydown") return;
            if ((e.key == "m" || e.key == "M") && !e.ctrlKey && !e.metaKey) {
                this.toggle();
            } else if (e.key == "Escape" && this.#active) {
                e.preventDefault();
                if (this.#start && !this.#finished) {
                    this.#start = this.#end = undefined;
                    this.#notify();
                } else {
                    this.toggle(false);
                }
            }
        };

        canvas.addEventListener("mousemove", on_move);
        canvas.addEventListener("click", on_click);
        window.addEventListener("keydown", on_key);
        window.addEventListener("keyup", on_key);
        this.addDisposable({
            dispose: () => {
                canvas.removeEventListener("mousemove", on_move);
                canvas.removeEventListener("click", on_click);
                window.removeEventListener("keydown", on_key);
                window.removeEventListener("keyup", on_key);
                window.cancelAnimationFrame(this.#frame);
            },
        });
    }

    /** Turns measuring on or off. */
    toggle(on = !this.#active) {
        if (!this.viewer) return;
        this.#active = on;
        this.toggleAttribute("active", on);
        this.viewer.picking_enabled = !on;
        this.#start = this.#end = this.#snap = undefined;
        this.#finished = false;
        if (on) {
            this.#targets ??= new SnapTargets(this.viewer);
            this.canvas_cursor("crosshair");
            this.#loop();
        } else {
            this.canvas_cursor("");
            window.cancelAnimationFrame(this.#frame);
        }
        this.#notify();
    }

    private canvas_cursor(cursor: string) {
        this.viewer.canvas.style.cursor = cursor;
    }

    /** Updates the snapped point under the mouse. */
    #track() {
        const zoom = this.viewer.viewport.camera.zoom;
        this.#snap = this.#targets?.snap(
            this.viewer.mouse_position.copy(),
            snap_radius / zoom,
        );
        if (this.#start && !this.#finished) {
            this.#end = this.#current_point();
            this.#notify();
        }
    }

    /** The snapped point, constrained to horizontal/vertical with shift */
    #current_point() {
        const p = (this.#snap?.point ?? this.viewer.mouse_position).copy();
        if (this.#shift && this.#start && !this.#finished) {
            const d = p.sub(this.#start);
            return Math.abs(d.x) >= Math.abs(d.y)
                ? new Vec2(p.x, this.#start.y)
                : new Vec2(this.#start.x, p.y);
        }
        return p;
    }

    /** The current measurement, in mm and degrees */
    get measurement() {
        if (!this.#start || !this.#end) return undefined;
        const d = this.#end.sub(this.#start);
        return {
            distance: d.magnitude,
            dx: d.x,
            dy: -d.y,
            // Counterclockwise from the X axis, with Y up, like KiCad.
            angle: (Math.atan2(-d.y, d.x) * 180) / Math.PI,
        };
    }

    #describe() {
        const m = this.measurement;
        if (!m) return "";
        return (
            `${m.distance.toFixed(3)} mm · Δx ${m.dx.toFixed(3)} · ` +
            `Δy ${m.dy.toFixed(3)} · ${m.angle.toFixed(1)}°`
        );
    }

    #notify() {
        let hint: string | null = null;
        if (this.#active) {
            if (!this.#start) {
                hint =
                    "Measure: click the start point (snaps to hole and pad centers and edges) · Esc: exit";
            } else if (!this.#finished) {
                hint = `${this.#describe()} · Click the end point · Shift: horizontal/vertical · Esc: cancel`;
            } else {
                hint = `${this.#describe()} · Click to measure again · Esc: exit`;
            }
        }
        window.dispatchEvent(
            new CustomEvent("kicanvas:hint", {
                detail: { source: "measure", text: hint },
            }),
        );
        this.dispatchEvent(
            new CustomEvent(KCBoardMeasureElement.change_event, {
                detail: this.#active,
                bubbles: true,
                composed: true,
            }),
        );
    }

    /** Redraws the overlay every frame while active (the view can move). */
    #loop() {
        this.#draw();
        if (this.#active) {
            this.#frame = window.requestAnimationFrame(() => this.#loop());
        }
    }

    #draw() {
        const svg = this.renderRoot.querySelector("svg");
        if (!svg) return;

        const camera = this.viewer.viewport.camera;
        const canvas_rect = this.viewer.canvas.getBoundingClientRect();
        const own_rect = this.getBoundingClientRect();
        const ox = canvas_rect.x - own_rect.x;
        const oy = canvas_rect.y - own_rect.y;
        const s = (p: Vec2) => {
            const q = camera.world_to_screen(p);
            return { x: q.x + ox, y: q.y + oy };
        };

        const parts: string[] = [];

        if (this.#snap && this.#snap.kind != "free") {
            const p = s(this.#snap.point);
            parts.push(
                this.#snap.kind == "center"
                    ? `<circle class="snap" cx="${p.x}" cy="${p.y}" r="6"/>`
                    : `<rect class="snap" x="${p.x - 4}" y="${p.y - 4}" width="8" height="8"/>`,
            );
        }

        if (this.#start && this.#end) {
            const a = s(this.#start);
            const b = s(this.#end);
            parts.push(
                `<line class="leg" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${a.y}"/>`,
                `<line class="leg" x1="${b.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`,
                `<line class="line" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`,
                `<circle class="end" cx="${a.x}" cy="${a.y}" r="3"/>`,
                `<circle class="end" cx="${b.x}" cy="${b.y}" r="3"/>`,
            );
            const m = this.measurement!;
            const lines = [
                `${m.distance.toFixed(3)} mm`,
                `Δx ${m.dx.toFixed(3)}  Δy ${m.dy.toFixed(3)}  ${m.angle.toFixed(1)}°`,
            ];
            const w = 190;
            const h = 38;
            const lx = Math.min(b.x + 14, own_rect.width - w - 4);
            const ly = Math.min(b.y + 14, own_rect.height - h - 4);
            parts.push(
                `<g class="label"><rect x="${lx}" y="${ly}" width="${w}" height="${h}" rx="3"/>` +
                    `<text class="main" x="${lx + 8}" y="${ly + 16}">${lines[0]}</text>` +
                    `<text x="${lx + 8}" y="${ly + 31}">${lines[1]}</text></g>`,
            );
        }

        svg.innerHTML = parts.join("");
    }

    override render() {
        return html`<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
    }
}

window.customElements.define("kc-board-measure", KCBoardMeasureElement);
