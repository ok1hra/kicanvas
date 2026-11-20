/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Angle, Arc as MathArc, BBox, Matrix3, Vec2 } from "../../base/math";
import {
    Arc,
    ArcSegment,
    Circle,
    Footprint,
    Line,
    LineSegment,
    Pad,
    Poly,
    Rect,
    Via,
    type KicadPCB,
} from "../../kicad/board";

/** Something under the pointer on a board. */
export type BoardHit =
    | { kind: "footprint"; footprint: Footprint }
    | {
          kind: "net";
          net: number;
          name: string;
          /** What was hit: "track", "via", "pad 3", "zone" */
          what: string;
          layer: string;
      };

type Segment = [Vec2, Vec2];

export function distance_to_segment(p: Vec2, a: Vec2, b: Vec2) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = len2 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = p.x - (a.x + abx * t);
    const dy = p.y - (a.y + aby * t);
    return Math.sqrt(dx * dx + dy * dy);
}

/** Even-odd test against a set of edges, which don't have to be ordered. */
export function inside_edges(p: Vec2, edges: Segment[]) {
    let inside = false;
    for (const [a, b] of edges) {
        if (a.y > p.y != b.y > p.y) {
            const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
            if (p.x < x) {
                inside = !inside;
            }
        }
    }
    return inside;
}

function polyline_edges(pts: Vec2[], closed: boolean): Segment[] {
    const edges: Segment[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
        edges.push([pts[i]!, pts[i + 1]!]);
    }
    if (closed && pts.length > 2) {
        edges.push([pts.at(-1)!, pts[0]!]);
    }
    return edges;
}

function footprint_matrix(fp: Footprint) {
    return Matrix3.translation(fp.at.position.x, fp.at.position.y).rotate_self(
        Angle.deg_to_rad(fp.at.rotation),
    );
}

/** Copper layers from the top (F.Cu) to the bottom (B.Cu). */
export function copper_stack(board: KicadPCB): string[] {
    const inner = board.layers
        .map((l) => l.canonical_name)
        .filter((n) => /^In\d+\.Cu$/.test(n))
        .sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10));
    return ["F.Cu", ...inner, "B.Cu"];
}

/** The copper layers a via connects. */
function via_layers(via: Via, stack: string[]) {
    if (via.type == "through-hole" || via.layers.length < 2) {
        return stack;
    }
    const a = stack.indexOf(via.layers[0]!);
    const b = stack.indexOf(via.layers[1]!);
    if (a < 0 || b < 0) {
        return stack;
    }
    return stack.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The copper layers a pad is on. */
function pad_layers(pad: Pad, stack: string[]) {
    const layers = new Set<string>();
    for (const l of pad.layers) {
        if (l == "*.Cu") {
            if (pad.type == "smd" || pad.type == "connect") {
                layers.add("F.Cu");
                layers.add("B.Cu");
            } else {
                stack.forEach((s) => layers.add(s));
            }
        } else if (l.endsWith(".Cu")) {
            layers.add(l);
        }
    }
    return layers;
}

/**
 * Whether p is in a pad. Pads are tested as their (rotated) bounding
 * rectangle, or circle; that's precise enough for picking.
 */
function in_pad(fp_matrix: Matrix3, pad: Pad, p: Vec2, tolerance: number) {
    const m = fp_matrix
        .copy()
        .translate_self(pad.at.position.x, pad.at.position.y)
        .rotate_self(-Angle.deg_to_rad(pad.parent.at.rotation))
        .rotate_self(Angle.deg_to_rad(pad.at.rotation));
    const local = m.inverse().transform(p);
    const w = pad.size.x / 2 + tolerance;
    const h = pad.size.y / 2 + tolerance;
    if (pad.shape == "circle") {
        return local.magnitude <= w;
    }
    if (pad.shape == "oval") {
        // A stadium: a segment between the centers of the round ends.
        const r = Math.min(pad.size.x, pad.size.y) / 2;
        const half = Math.abs(pad.size.x - pad.size.y) / 2;
        const a =
            pad.size.x > pad.size.y ? new Vec2(-half, 0) : new Vec2(0, -half);
        return distance_to_segment(local, a, a.multiply(-1)) <= r + tolerance;
    }
    return Math.abs(local.x) <= w && Math.abs(local.y) <= h;
}

function arc_points(start: Vec2, mid: Vec2, end: Vec2) {
    return MathArc.from_three_points(start, mid, end).to_polyline();
}

/**
 * Courtyard outlines of footprints, in board coordinates, computed once per
 * footprint.
 */
const courtyards = new WeakMap<
    Footprint,
    { edges: Segment[]; circles: [Vec2, number][] } | null
>();

function courtyard(fp: Footprint) {
    let found = courtyards.get(fp);
    if (found !== undefined) {
        return found;
    }

    const m = footprint_matrix(fp);
    const t = (v: Vec2) => m.transform(v);
    const edges: Segment[] = [];
    const circles: [Vec2, number][] = [];

    for (const d of fp.drawings) {
        const layer = (d as { layer?: string }).layer;
        if (layer != "F.CrtYd" && layer != "B.CrtYd") {
            continue;
        }
        if (d instanceof Line) {
            edges.push([t(d.start), t(d.end)]);
        } else if (d instanceof Rect) {
            const a = d.start;
            const b = d.end;
            edges.push(
                ...polyline_edges(
                    [a, new Vec2(b.x, a.y), b, new Vec2(a.x, b.y)].map(t),
                    true,
                ),
            );
        } else if (d instanceof Poly) {
            edges.push(...polyline_edges(d.polyline.map(t), true));
        } else if (d instanceof Circle) {
            circles.push([t(d.center), d.end.sub(d.center).magnitude]);
        } else if (d instanceof Arc) {
            edges.push(
                ...polyline_edges(
                    arc_points(d.start, d.mid, d.end).map(t),
                    false,
                ),
            );
        }
    }

    found = edges.length || circles.length ? { edges, circles } : null;
    courtyards.set(fp, found);
    return found;
}

/** Whether p is inside a footprint's courtyard (or its outline). */
export function in_footprint(fp: Footprint, p: Vec2) {
    const c = courtyard(fp);
    if (!c) {
        // No courtyard: use the footprint's graphics.
        return fp.bbox.contains_point(p);
    }
    return (
        inside_edges(p, c.edges) ||
        c.circles.some(([center, r]) => center.sub(p).magnitude <= r)
    );
}

const pads_bboxes = new WeakMap<Footprint, BBox>();

/** A box around a footprint's pads (in board coordinates). */
function pads_bbox(fp: Footprint) {
    let bbox = pads_bboxes.get(fp);
    if (!bbox) {
        const m = footprint_matrix(fp);
        const boxes = fp.pads.map((pad) => {
            const r = Math.max(pad.size.x, pad.size.y) / 2 + 0.5;
            const c = m.transform(pad.at.position);
            return new BBox(c.x - r, c.y - r, 2 * r, 2 * r);
        });
        bbox = BBox.combine(boxes);
        pads_bboxes.set(fp, bbox);
    }
    return bbox;
}

export type PickOptions = {
    /** How far from tracks and pads a click can be, in mm */
    tolerance: number;
    /** Viewing from the back: back side items come first. */
    flipped: boolean;
    is_visible: (layer: string) => boolean;
    /** Whether zones are drawn filled, which makes them clickable. */
    zone_fills: boolean;
};

/**
 * What's under the pointer, like KiCad's selection: footprints whose
 * courtyard contains the point, and the nets of copper on the topmost
 * visible copper layer with something there. Inside a footprint, only copper
 * on the footprint's own side counts, so that a click on a part isn't taken
 * as a click on a track running below it on an inner layer.
 */
export function pick_board(
    board: KicadPCB,
    p: Vec2,
    opts: PickOptions,
): BoardHit[] {
    const stack = copper_stack(board).filter((l) => opts.is_visible(l));
    if (opts.flipped) {
        stack.reverse();
    }
    const top_side = opts.flipped ? "B." : "F.";

    // Footprints: those on the side facing the viewer first, and those on
    // the other side only if there are none.
    const side_visible = (side: string) =>
        ["Cu", "CrtYd", "SilkS", "Fab"].some((l) =>
            opts.is_visible(`${side}${l}`),
        );
    let footprints = board.footprints.filter((fp) => {
        const side = fp.layer?.startsWith("B.") ? "B." : "F.";
        return side_visible(side) && in_footprint(fp, p);
    });
    const facing = footprints.filter((fp) =>
        (fp.layer ?? "F.Cu").startsWith(top_side),
    );
    if (facing.length) {
        footprints = facing;
    }

    // Copper, by layer.
    const by_layer = new Map<string, BoardHit[]>();
    const add = (layer: string, hit: BoardHit) => {
        const list = by_layer.get(layer) ?? [];
        list.push(hit);
        by_layer.set(layer, list);
    };
    const net_name = (n: number) => board.get_netname_by_number(n) ?? "";
    const tol = opts.tolerance;

    // Pads first: a pad is what the user sees on top of a track.
    for (const fp of board.footprints) {
        if (!pads_bbox(fp).contains_point(p)) {
            continue;
        }
        const m = footprint_matrix(fp);
        for (const pad of fp.pads) {
            const layers = [...pad_layers(pad, stack)].filter((l) =>
                stack.includes(l),
            );
            if (!layers.length || !in_pad(m, pad, p, tol)) {
                continue;
            }
            const net = pad.net?.number;
            if (net) {
                for (const layer of layers) {
                    add(layer, {
                        kind: "net",
                        net,
                        name: pad.net.name,
                        what: `pad ${pad.number}`,
                        layer,
                    });
                }
            }
            // Clicking a pad picks its footprint too.
            if (!footprints.includes(fp)) {
                footprints.push(fp);
            }
        }
    }

    for (const v of board.vias) {
        if (!v.net || v.at.position.sub(p).magnitude > v.size / 2 + tol) {
            continue;
        }
        for (const layer of via_layers(v, stack)) {
            add(layer, {
                kind: "net",
                net: v.net,
                name: net_name(v.net),
                what: "via",
                layer,
            });
        }
    }

    for (const s of board.segments) {
        if (!s.net || !stack.includes(s.layer)) {
            continue;
        }
        let d = Infinity;
        if (s instanceof LineSegment) {
            d = distance_to_segment(p, s.start, s.end);
        } else if (s instanceof ArcSegment) {
            const pts = arc_points(s.start, s.mid, s.end);
            for (let i = 0; i < pts.length - 1; i++) {
                d = Math.min(d, distance_to_segment(p, pts[i]!, pts[i + 1]!));
            }
        }
        if (d <= s.width / 2 + tol) {
            add(s.layer, {
                kind: "net",
                net: s.net,
                name: net_name(s.net),
                what: "track",
                layer: s.layer,
            });
        }
    }

    if (opts.zone_fills) {
        for (const z of board.zones) {
            if (!z.net || !z.filled_polygons) {
                continue;
            }
            for (const fill of z.filled_polygons) {
                const layer = fill.layer;
                if (
                    !stack.includes(layer) ||
                    !fill.bbox.contains_point(p) ||
                    !inside_edges(p, polyline_edges(fill.polyline, true))
                ) {
                    continue;
                }
                // Zones only count where nothing else is.
                if (!by_layer.get(layer)?.length) {
                    add(layer, {
                        kind: "net",
                        net: z.net,
                        name: net_name(z.net),
                        what: "zone",
                        layer,
                    });
                }
            }
        }
    }

    // The topmost layer with copper there; inside a footprint, only the
    // footprint's own side.
    let layers = stack;
    if (footprints.length) {
        const sides = new Set<string>(
            footprints.map((fp) =>
                fp.layer?.startsWith("B.") ? "B.Cu" : "F.Cu",
            ),
        );
        layers = stack.filter((l) => sides.has(l));
    }
    let nets: BoardHit[] = [];
    for (const layer of layers) {
        const hits = by_layer.get(layer);
        if (hits?.length) {
            nets = hits;
            break;
        }
    }

    // One entry per net.
    const seen = new Set<number>();
    nets = nets.filter((h) => {
        const n = (h as { net: number }).net;
        if (seen.has(n)) {
            return false;
        }
        seen.add(n);
        return true;
    });

    return [
        ...footprints.map((footprint) => ({
            kind: "footprint" as const,
            footprint,
        })),
        ...nets,
    ];
}
