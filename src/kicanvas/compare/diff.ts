/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox } from "../../base/math";
import type { KicadPCB } from "../../kicad";
import { ArcSegment, Footprint, LineSegment, Poly } from "../../kicad/board";
import {
    instance_for,
    type KicadSch,
    type SchematicSymbol,
} from "../../kicad/schematic";
import { SheetConnectivity } from "../../viewers/schematic/connectivity";
import { CrossProbeIndex, NetGroups, reference_in } from "../cross-probe";
import type { Project, ProjectPage } from "../project";

/**
 * A semantic comparison of two revisions of a project: which parts, nets
 * and board items changed, rather than which lines of the files.
 */

export type Category = "components" | "nets" | "layout";
export type ChangeKind = "added" | "removed" | "modified";

/** A symbol on a sheet instance. */
export type SchLocation = { sheet_path: string; symbol: string };

export type Change = {
    id: number;
    category: Category;
    kind: ChangeKind;
    title: string;
    details: string[];
    /** References of the parts involved */
    refs: string[];
    /** Nets to highlight, by CrossProbeIndex key, in A and B */
    nets_a: string[];
    nets_b: string[];
    /** Where the change is in the schematic of A and of B */
    sch_a: SchLocation[];
    sch_b: SchLocation[];
    /** Sheets the change is on (by sheet path) */
    sheets: string[];
    /** Where the change is on the board of A and of B */
    board_a?: BBox;
    board_b?: BBox;
};

/** A row of the bill of materials comparison. */
export type BomRow = {
    status: "added" | "removed" | "changed";
    value: string;
    footprint: string;
    mpn: string;
    id: string;
    refs_a: string[];
    refs_b: string[];
};

/** A move of (most of) the board layout from A to B. */
export type LayoutShift = {
    dx: number;
    dy: number;
    count: number;
    total: number;
};

export type Comparison = {
    changes: Change[];
    bom: BomRow[];
    /**
     * If the layout was moved as a whole, by how much. Board positions in
     * A plus the shift are positions in B.
     */
    shift?: LayoutShift;
};

// Parts

export type Part = {
    ref: string;
    value: string;
    footprint: string;
    lib_id: string;
    fields: Map<string, string>;
    dnp: boolean;
    in_bom: boolean;
    on_board: boolean;
    placements: { page: ProjectPage; symbol: SchematicSymbol }[];
};

/** Schematic pages that are part of the sheet hierarchy. */
export function hierarchy_pages(project: Project): ProjectPage[] {
    return [...project.pages()].filter(
        (p) =>
            p.type == "schematic" &&
            (p.page !== undefined || p == project.root_schematic_page),
    );
}

export function first_board(project: Project): KicadPCB | undefined {
    for (const board of project.boards()) {
        return board;
    }
    return undefined;
}

export function collect_parts(project: Project): Map<string, Part> {
    const parts = new Map<string, Part>();
    for (const page of hierarchy_pages(project)) {
        for (const symbol of (page.document as KicadSch).symbols.values()) {
            if (symbol.lib_symbol.power) {
                continue;
            }
            const ref = reference_in(page, symbol);
            if (!ref || ref.includes("?") || ref.startsWith("#")) {
                continue;
            }
            const existing = parts.get(ref);
            if (existing) {
                // Another unit of the part.
                existing.placements.push({ page, symbol });
                continue;
            }
            const instance = instance_for(symbol.instances, page.sheet_path);
            const fields = new Map<string, string>();
            for (const prop of symbol.properties.values()) {
                if (
                    ["Reference", "Value", "Footprint"].includes(prop.name) ||
                    prop.name.startsWith("ki_")
                ) {
                    continue;
                }
                fields.set(prop.name, prop.shown_text ?? prop.text ?? "");
            }
            parts.set(ref, {
                ref,
                value:
                    instance?.value ??
                    symbol.properties.get("Value")?.shown_text ??
                    "",
                footprint:
                    instance?.footprint ??
                    symbol.properties.get("Footprint")?.shown_text ??
                    "",
                lib_id: symbol.lib_id,
                fields,
                dnp: !!symbol.dnp,
                in_bom: symbol.in_bom !== false,
                on_board: symbol.on_board !== false,
                placements: [{ page, symbol }],
            });
        }
    }
    return parts;
}

const placements_of = (part?: Part): SchLocation[] =>
    part?.placements.map(({ page, symbol }) => ({
        sheet_path: page.sheet_path,
        symbol: symbol.uuid,
    })) ?? [];

const yes_no = (v: boolean) => (v ? "yes" : "no");
const show = (v: string | undefined) => (v === undefined || v === "" ? "—" : v);

// Nets

export type NetInfo = {
    /** Identifies the net within its revision */
    id: string;
    /** For highlighting, see CrossProbeIndex.net_key() */
    key: string;
    name: string;
    pins: Set<string>;
};

export type Netlist = {
    index: CrossProbeIndex;
    nets: Map<string, NetInfo>;
    /** Pin ("R1.2") to net id; unconnected pins aren't listed */
    pin_net: Map<string, string>;
};

/** A board without anything, for projects without one. */
function empty_board(): KicadPCB {
    return {
        footprints: [],
        net_by_name: () => undefined,
    } as unknown as KicadPCB;
}

export function netlist(project: Project, board?: KicadPCB): Netlist {
    const index = new CrossProbeIndex(project, board ?? empty_board());
    const nets = new Map<string, NetInfo>();
    const labels = new Map<string, string>();

    // Nets are the schematic's: the board only names them.
    for (const page of index.pages) {
        const conn = SheetConnectivity.for(page.document as KicadSch);
        for (const net of conn.nets) {
            const group = index.groups.group(page, net);
            const key = index.net_key(page, net);
            if (group === undefined || !key) {
                continue;
            }
            const id = `${group}`;
            let info = nets.get(id);
            if (!info) {
                info = { id, key, name: key, pins: new Set() };
                nets.set(id, info);
            }
            for (const pin of net.part_pins) {
                const ref = reference_in(page, pin.symbol);
                if (ref && !ref.includes("?")) {
                    info.pins.add(`${ref}.${pin.number}`);
                }
            }
            if (NetGroups.is_made_up(key) && !labels.has(id)) {
                const name = index.label_net_names(page, net)[0];
                if (name) {
                    labels.set(id, name);
                }
            }
        }
    }

    // Pins of parts with the same reference in several places can be in
    // several nets; they can't be followed, so they're left out.
    const seen = new Map<string, number>();
    for (const info of nets.values()) {
        for (const pin of info.pins) {
            seen.set(pin, (seen.get(pin) ?? 0) + 1);
        }
    }

    const pin_net = new Map<string, string>();
    for (const info of nets.values()) {
        if (NetGroups.is_made_up(info.key)) {
            // Name it like KiCad names nets without labels.
            const first = [...info.pins].sort()[0];
            info.name =
                labels.get(info.id) ??
                (first
                    ? `Net-(${first.replace(/\.([^.]*)$/, "-Pad$1")})`
                    : info.key);
        }
        // A pin alone isn't connected to anything.
        if (info.pins.size < 2) {
            continue;
        }
        for (const pin of info.pins) {
            if (seen.get(pin) == 1) {
                pin_net.set(pin, info.id);
            }
        }
    }

    return { index, nets, pin_net };
}

const pin_ref = (pin: string) => pin.replace(/\.[^.]*$/, "");

function sorted_pins(pins: Iterable<string>) {
    return [...pins].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
    );
}

function list(items: string[], max = 8) {
    return items.length > max
        ? `${items.slice(0, max).join(", ")} … (+${items.length - max})`
        : items.join(", ");
}

// Board items

const round = (v: number) => Math.round(v * 1000);

function segment_key(s: LineSegment | ArcSegment, ox = 0, oy = 0) {
    const a = `${round(s.start.x + ox)},${round(s.start.y + oy)}`;
    const b = `${round(s.end.x + ox)},${round(s.end.y + oy)}`;
    const [p, q] = a < b ? [a, b] : [b, a];
    const mid =
        s instanceof ArcSegment
            ? `${round(s.mid.x + ox)},${round(s.mid.y + oy)}`
            : "";
    return `${s.layer}|${round(s.width)}|${p}|${q}|${mid}`;
}

function segment_bbox(s: LineSegment | ArcSegment) {
    const pts = [s.start, s.end];
    if (s instanceof ArcSegment) {
        pts.push(s.mid);
    }
    return BBox.from_points(pts).grow(s.width / 2);
}

function pads_signature(fp: Footprint) {
    return fp.pads
        .map(
            (p) =>
                `${p.number}:${p.shape}:${round(p.at.position.x)},${round(p.at.position.y)}:${round(p.size.x)}x${round(p.size.y)}:${p.layers.join("+")}`,
        )
        .sort()
        .join(";");
}

function outline_signature(board: KicadPCB, ox = 0, oy = 0) {
    return board.drawings
        .filter((d) => (d as { layer?: string }).layer == "Edge.Cuts")
        .map((d) => {
            const g = d as unknown as Record<string, unknown>;
            const pts = ["start", "mid", "end", "center"]
                .map((k) => g[k] as { x: number; y: number } | undefined)
                .filter((v) => v)
                .map((v) => `${round(v!.x + ox)},${round(v!.y + oy)}`);
            if (g instanceof Poly) {
                pts.push(
                    ...g.polyline.map(
                        (v) => `${round(v.x + ox)},${round(v.y + oy)}`,
                    ),
                );
            }
            return `${g.constructor.name}:${pts.join(" ")}`;
        })
        .sort();
}

/**
 * Compares two revisions of a project: A (older, the base) and B (newer).
 */
export function compare_projects(a: Project, b: Project): Comparison {
    const changes: Change[] = [];
    const add = (c: Omit<Change, "id" | "sheets">) => {
        const sheets = [
            ...new Set([...c.sch_b, ...c.sch_a].map((l) => l.sheet_path)),
        ];
        changes.push({ ...c, id: changes.length, sheets });
    };
    const board_a = first_board(a);
    const board_b = first_board(b);
    const fp_a = new Map(board_a?.footprints.map((f) => [f.reference, f]));
    const fp_b = new Map(board_b?.footprints.map((f) => [f.reference, f]));

    // Parts (and their BOM data).
    const parts_a = collect_parts(a);
    const parts_b = collect_parts(b);
    const refs = sorted_pins(new Set([...parts_a.keys(), ...parts_b.keys()]));

    for (const ref of refs) {
        const pa = parts_a.get(ref);
        const pb = parts_b.get(ref);
        const base = {
            category: "components" as const,
            refs: [ref],
            nets_a: [],
            nets_b: [],
            sch_a: placements_of(pa),
            sch_b: placements_of(pb),
            board_a: fp_a.get(ref)?.bbox,
            board_b: fp_b.get(ref)?.bbox,
        };
        if (!pa && pb) {
            add({
                ...base,
                kind: "added",
                title: `${ref} added`,
                details: [`${pb.value} · ${show(pb.footprint)}`],
            });
            continue;
        }
        if (pa && !pb) {
            add({
                ...base,
                kind: "removed",
                title: `${ref} removed`,
                details: [`${pa.value} · ${show(pa.footprint)}`],
            });
            continue;
        }
        if (!pa || !pb) {
            continue;
        }

        const details: string[] = [];
        const diff = (name: string, x: string, y: string) => {
            if (x != y) {
                details.push(`${name}: ${show(x)} → ${show(y)}`);
            }
        };
        diff("Value", pa.value, pb.value);
        diff("Footprint", pa.footprint, pb.footprint);
        diff("Symbol", pa.lib_id, pb.lib_id);
        diff("DNP", yes_no(pa.dnp), yes_no(pb.dnp));
        diff("In BOM", yes_no(pa.in_bom), yes_no(pb.in_bom));
        diff("On board", yes_no(pa.on_board), yes_no(pb.on_board));
        const names = new Set([...pa.fields.keys(), ...pb.fields.keys()]);
        for (const name of names) {
            diff(name, pa.fields.get(name) ?? "", pb.fields.get(name) ?? "");
        }
        if (details.length) {
            add({
                ...base,
                kind: "modified",
                title: `${ref} changed`,
                details,
            });
        }
    }

    // Nets, from the schematic: compared by the pins they connect, so
    // that renamed nets are recognized.
    const nl_a = netlist(a, board_a);
    const nl_b = netlist(b, board_b);
    const common = (pin: string) =>
        parts_a.has(pin_ref(pin)) && parts_b.has(pin_ref(pin));

    const overlap = (from: Netlist, to: Netlist) => {
        const result = new Map<string, Map<string, number>>();
        for (const [key, info] of from.nets) {
            const targets = new Map<string, number>();
            for (const pin of info.pins) {
                const target = to.pin_net.get(pin);
                if (common(pin) && target && from.pin_net.has(pin)) {
                    targets.set(target, (targets.get(target) ?? 0) + 1);
                }
            }
            result.set(key, targets);
        }
        return result;
    };
    const a2b = overlap(nl_a, nl_b);
    const b2a = overlap(nl_b, nl_a);
    const name_a = (id: string) => nl_a.nets.get(id)?.name ?? id;
    const name_b = (id: string) => nl_b.nets.get(id)?.name ?? id;
    const keys_of = (nl: Netlist, ids: string[]) => [
        ...new Set(ids.map((id) => nl.nets.get(id)?.key ?? id)),
    ];
    const sheets_of = (nl: Netlist, keys: string[]): SchLocation[] =>
        keys.flatMap((k) =>
            nl.index.pages_with_net(k).map((p) => ({
                sheet_path: p.sheet_path,
                symbol: "",
            })),
        );
    const net_change = (
        kind: ChangeKind,
        title: string,
        details: string[],
        ids_a: string[],
        ids_b: string[],
        pins: string[],
    ) => {
        const keys_a = keys_of(nl_a, ids_a);
        const keys_b = keys_of(nl_b, ids_b);
        add({
            category: "nets",
            kind,
            title,
            details,
            refs: [...new Set(pins.map(pin_ref))],
            nets_a: keys_a,
            nets_b: keys_b,
            sch_a: sheets_of(nl_a, keys_a),
            sch_b: sheets_of(nl_b, keys_b),
            board_a: board_a ? net_bbox(board_a, keys_a) : undefined,
            board_b: board_b ? net_bbox(board_b, keys_b) : undefined,
        });
    };

    for (const [ka, info] of nl_a.nets) {
        const connected = [...info.pins].filter(
            (p) => common(p) && nl_a.pin_net.has(p),
        );
        if (!connected.length) {
            continue;
        }
        const targets = [...a2b.get(ka)!.keys()];
        if (!targets.length) {
            net_change(
                "removed",
                `Net ${name_a(ka)} removed`,
                [`Pins no longer connected: ${list(sorted_pins(connected))}`],
                [ka],
                [],
                connected,
            );
        } else if (targets.length > 1) {
            net_change(
                "modified",
                `Net ${name_a(ka)} split`,
                [`Split into ${targets.map(name_b).join(", ")}`],
                [ka],
                targets,
                connected,
            );
        } else {
            const kb = targets[0]!;
            if (b2a.get(kb)!.size > 1) {
                continue; // A merge, reported below.
            }
            const details: string[] = [];
            if (name_a(ka) != name_b(kb)) {
                details.push(`Renamed: ${name_a(ka)} → ${name_b(kb)}`);
            }
            const pins_b = nl_b.nets.get(kb)!.pins;
            const gone = connected.filter((p) => !pins_b.has(p));
            const came = [...pins_b].filter(
                (p) => common(p) && nl_b.pin_net.has(p) && !info.pins.has(p),
            );
            if (came.length) {
                details.push(`Connected: ${list(sorted_pins(came))}`);
            }
            if (gone.length) {
                details.push(`Disconnected: ${list(sorted_pins(gone))}`);
            }
            if (details.length) {
                net_change(
                    "modified",
                    name_a(ka) != name_b(kb)
                        ? `Net ${name_a(ka)} renamed`
                        : `Net ${name_b(kb)} changed`,
                    details,
                    [ka],
                    [kb],
                    [...came, ...gone],
                );
            }
        }
    }

    for (const [kb, info] of nl_b.nets) {
        const connected = [...info.pins].filter(
            (p) => common(p) && nl_b.pin_net.has(p),
        );
        if (!connected.length) {
            continue;
        }
        const sources = [...b2a.get(kb)!.keys()];
        if (!sources.length) {
            net_change(
                "added",
                `Net ${name_b(kb)} added`,
                [`Connects ${list(sorted_pins(connected))}`],
                [],
                [kb],
                connected,
            );
        } else if (sources.length > 1) {
            net_change(
                "modified",
                `Nets merged into ${name_b(kb)}`,
                [`Merged: ${sources.map(name_a).join(", ")}`],
                sources,
                [kb],
                connected,
            );
        }
    }

    // Board.
    let shift: LayoutShift | undefined;
    if (board_a && board_b) {
        shift = layout_shift(fp_a, fp_b);
        compare_boards(board_a, board_b, fp_a, fp_b, add, shift);
    }

    return { changes, bom: compare_bom(parts_a, parts_b), shift };
}

function net_bbox(board: KicadPCB, keys: string[]) {
    const numbers = new Set(
        keys
            .map((k) => board.net_by_name(k)?.number)
            .filter((n) => n !== undefined),
    );
    if (!numbers.size) {
        return undefined;
    }
    const boxes: BBox[] = [];
    for (const s of board.segments) {
        if (numbers.has(s.net)) {
            boxes.push(segment_bbox(s));
        }
    }
    for (const v of board.vias) {
        if (numbers.has(v.net)) {
            boxes.push(
                new BBox(
                    v.at.position.x - v.size / 2,
                    v.at.position.y - v.size / 2,
                    v.size,
                    v.size,
                ),
            );
        }
    }
    for (const fp of board.footprints) {
        if (fp.pads.some((p) => numbers.has(p.net?.number))) {
            boxes.push(fp.bbox);
        }
    }
    const bbox = BBox.combine(boxes);
    return bbox.valid ? bbox : undefined;
}

/**
 * Finds a move of the whole layout: the most common footprint move, if a
 * good part of the footprints moved by it.
 */
function layout_shift(
    fp_a: Map<string, Footprint>,
    fp_b: Map<string, Footprint>,
): LayoutShift | undefined {
    const moves = new Map<string, { dx: number; dy: number; n: number }>();
    let total = 0;
    for (const [ref, x] of fp_a) {
        const y = fp_b.get(ref);
        if (!y) {
            continue;
        }
        total++;
        const dx = y.at.position.x - x.at.position.x;
        const dy = y.at.position.y - x.at.position.y;
        const key = `${Math.round(dx * 100)},${Math.round(dy * 100)}`;
        const m = moves.get(key) ?? { dx, dy, n: 0 };
        m.n++;
        moves.set(key, m);
    }
    const best = [...moves.values()].sort((a, b) => b.n - a.n)[0];
    if (
        !best ||
        (Math.abs(best.dx) < 0.01 && Math.abs(best.dy) < 0.01) ||
        best.n < Math.max(5, total * 0.25)
    ) {
        return undefined;
    }
    return { dx: best.dx, dy: best.dy, count: best.n, total };
}

function compare_boards(
    a: KicadPCB,
    b: KicadPCB,
    fp_a: Map<string, Footprint>,
    fp_b: Map<string, Footprint>,
    add: (c: Omit<Change, "id" | "sheets">) => void,
    shift?: LayoutShift,
) {
    const sx = shift?.dx ?? 0;
    const sy = shift?.dy ?? 0;
    const layout = (
        kind: ChangeKind,
        title: string,
        details: string[],
        refs: string[],
        board_a?: BBox,
        board_b?: BBox,
        nets_a: string[] = [],
        nets_b: string[] = [],
    ) =>
        add({
            category: "layout",
            kind,
            title,
            details,
            refs,
            nets_a,
            nets_b,
            sch_a: [],
            sch_b: [],
            board_a,
            board_b,
        });

    if (shift) {
        layout(
            "modified",
            "Layout moved",
            [
                `By ${shift.dx.toFixed(3)}, ${shift.dy.toFixed(3)} mm (${shift.count} of ${shift.total} footprints); A is aligned to B`,
            ],
            [],
            a.edge_cuts_bbox.valid ? a.edge_cuts_bbox : undefined,
            b.edge_cuts_bbox.valid ? b.edge_cuts_bbox : undefined,
        );
    }

    // Footprints.
    const refs = sorted_pins(new Set([...fp_a.keys(), ...fp_b.keys()]));
    for (const ref of refs) {
        const x = fp_a.get(ref);
        const y = fp_b.get(ref);
        if (!x && y) {
            layout(
                "added",
                `Footprint ${ref} added`,
                [y.library_link],
                [ref],
                undefined,
                y.bbox,
            );
        } else if (x && !y) {
            layout(
                "removed",
                `Footprint ${ref} removed`,
                [x.library_link],
                [ref],
                x.bbox,
            );
        } else if (x && y) {
            const details: string[] = [];
            // Moves relative to the whole layout's.
            const dx = y.at.position.x - x.at.position.x - sx;
            const dy = y.at.position.y - x.at.position.y - sy;
            if (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005) {
                details.push(`Moved by ${dx.toFixed(3)}, ${dy.toFixed(3)} mm`);
            }
            if ((x.at.rotation ?? 0) != (y.at.rotation ?? 0)) {
                details.push(
                    `Rotated: ${x.at.rotation ?? 0}° → ${y.at.rotation ?? 0}°`,
                );
            }
            if (x.layer != y.layer) {
                details.push(
                    `Side: ${x.layer.startsWith("B.") ? "bottom" : "top"} → ${y.layer.startsWith("B.") ? "bottom" : "top"}`,
                );
            }
            if (x.library_link != y.library_link) {
                details.push(
                    `Footprint: ${x.library_link} → ${y.library_link}`,
                );
            } else if (
                x.layer == y.layer &&
                pads_signature(x) != pads_signature(y)
            ) {
                // (Flipping to the other side mirrors the pads.)
                details.push("Footprint geometry changed (pads)");
            }
            if (details.length) {
                layout(
                    "modified",
                    `Footprint ${ref} changed`,
                    details,
                    [ref],
                    x.bbox,
                    y.bbox,
                );
            }
        }
    }

    // Tracks and vias, by geometry, so that renamed nets don't count.
    type Item = { net: string; bbox: BBox; via: boolean };
    // A's items are keyed at their place in B, if the layout moved.
    const items = (board: KicadPCB, ox = 0, oy = 0) => {
        const map = new Map<string, Item>();
        for (const s of board.segments) {
            map.set(segment_key(s, ox, oy), {
                net: board.get_netname_by_number(s.net) ?? "",
                bbox: segment_bbox(s),
                via: false,
            });
        }
        for (const v of board.vias) {
            const key = `via|${round(v.at.position.x + ox)},${round(v.at.position.y + oy)}|${round(v.size)}|${round(v.drill)}|${v.layers.join("+")}`;
            map.set(key, {
                net: board.get_netname_by_number(v.net) ?? "",
                bbox: new BBox(
                    v.at.position.x - v.size / 2,
                    v.at.position.y - v.size / 2,
                    v.size,
                    v.size,
                ),
                via: true,
            });
        }
        return map;
    };
    const items_a = items(a, sx, sy);
    const items_b = items(b);
    type Routing = {
        added: Item[];
        removed: Item[];
    };
    const by_net = new Map<string, Routing>();
    const routing = (net: string) => {
        let r = by_net.get(net);
        if (!r) {
            r = { added: [], removed: [] };
            by_net.set(net, r);
        }
        return r;
    };
    for (const [key, item] of items_b) {
        if (!items_a.has(key)) {
            routing(item.net).added.push(item);
        }
    }
    for (const [key, item] of items_a) {
        if (!items_b.has(key)) {
            routing(item.net).removed.push(item);
        }
    }
    for (const [net, r] of [...by_net].sort((x, y) =>
        x[0].localeCompare(y[0], undefined, { numeric: true }),
    )) {
        const count = (list: Item[], via: boolean) =>
            list.filter((i) => i.via == via).length;
        const parts: string[] = [];
        const tracks = [count(r.added, false), count(r.removed, false)];
        const vias = [count(r.added, true), count(r.removed, true)];
        if (tracks[0] || tracks[1]) {
            parts.push(`tracks +${tracks[0]}/−${tracks[1]}`);
        }
        if (vias[0] || vias[1]) {
            parts.push(`vias +${vias[0]}/−${vias[1]}`);
        }
        const name = net || "(no net)";
        const kind: ChangeKind = !r.removed.length
            ? "added"
            : !r.added.length
              ? "removed"
              : "modified";
        const box = (list: Item[]) =>
            list.length ? BBox.combine(list.map((i) => i.bbox)) : undefined;
        layout(
            kind,
            `Routing of ${name}`,
            [parts.join(", ")],
            [],
            box(r.removed),
            box(r.added),
            net ? [net] : [],
            net ? [net] : [],
        );
    }

    // Zones, by outline (the fill follows from the rest).
    const zones = (board: KicadPCB, ox = 0, oy = 0) => {
        const map = new Map<
            string,
            { net: string; layers: string; bbox: BBox }
        >();
        for (const z of board.zones) {
            const pts = z.polygons.flatMap((p) => p.polyline);
            if (!pts.length) {
                continue;
            }
            const layers = (z.layers?.length ? z.layers : [z.layer]).join("+");
            const net = z.net_name || board.get_netname_by_number(z.net) || "";
            const key = `${layers}|${net}|${pts.map((v) => `${round(v.x + ox)},${round(v.y + oy)}`).join(" ")}`;
            map.set(key, { net, layers, bbox: BBox.from_points(pts) });
        }
        return map;
    };
    const zones_a = zones(a, sx, sy);
    const zones_b = zones(b);
    const zone_name = (z: { net: string; layers: string }) =>
        `Zone ${z.net || "(no net)"} on ${z.layers}`;
    const gone = [...zones_a]
        .filter(([k]) => !zones_b.has(k))
        .map(([, z]) => z);
    const came = [...zones_b]
        .filter(([k]) => !zones_a.has(k))
        .map(([, z]) => z);
    for (const z of came) {
        const before = gone.findIndex(
            (g) => g.net == z.net && g.layers == z.layers,
        );
        if (before >= 0) {
            const [old] = gone.splice(before, 1);
            layout(
                "modified",
                `${zone_name(z)} changed`,
                ["Outline changed"],
                [],
                old!.bbox,
                z.bbox,
                [z.net],
                [z.net],
            );
        } else {
            layout(
                "added",
                `${zone_name(z)} added`,
                [],
                [],
                undefined,
                z.bbox,
                [],
                [z.net],
            );
        }
    }
    for (const z of gone) {
        layout(
            "removed",
            `${zone_name(z)} removed`,
            [],
            [],
            z.bbox,
            undefined,
            [z.net],
            [],
        );
    }

    // Board outline.
    const outline_a = outline_signature(a, sx, sy);
    const outline_b = outline_signature(b);
    const set_a = new Set(outline_a);
    const set_b = new Set(outline_b);
    const plus = outline_b.filter((x) => !set_a.has(x)).length;
    const minus = outline_a.filter((x) => !set_b.has(x)).length;
    if (plus || minus) {
        layout(
            "modified",
            "Board outline changed",
            [`Edge.Cuts: +${plus}/−${minus} items`],
            [],
            a.edge_cuts_bbox.valid ? a.edge_cuts_bbox : undefined,
            b.edge_cuts_bbox.valid ? b.edge_cuts_bbox : undefined,
        );
    }
}

/** Groups parts like a BOM and compares the groups. */
function compare_bom(a: Map<string, Part>, b: Map<string, Part>): BomRow[] {
    type Group = {
        value: string;
        footprint: string;
        mpn: string;
        id: string;
        refs_a: string[];
        refs_b: string[];
    };
    const groups = new Map<string, Group>();
    const fill = (parts: Map<string, Part>, side: "refs_a" | "refs_b") => {
        for (const p of parts.values()) {
            if (p.dnp || !p.in_bom) {
                continue;
            }
            const mpn = p.fields.get("part_value") ?? p.fields.get("MPN") ?? "";
            const id = p.fields.get("ID") ?? "";
            const key = [p.value, p.footprint, mpn, id].join("\u0000");
            let g = groups.get(key);
            if (!g) {
                g = {
                    value: p.value,
                    footprint: p.footprint,
                    mpn,
                    id,
                    refs_a: [],
                    refs_b: [],
                };
                groups.set(key, g);
            }
            g[side].push(p.ref);
        }
    };
    fill(a, "refs_a");
    fill(b, "refs_b");

    const rows: BomRow[] = [];
    for (const g of groups.values()) {
        g.refs_a = sorted_pins(g.refs_a);
        g.refs_b = sorted_pins(g.refs_b);
        const same =
            g.refs_a.length == g.refs_b.length &&
            g.refs_a.every((r, i) => r == g.refs_b[i]);
        if (same) {
            continue;
        }
        rows.push({
            status: !g.refs_a.length
                ? "added"
                : !g.refs_b.length
                  ? "removed"
                  : "changed",
            ...g,
        });
    }
    return rows.sort((x, y) =>
        (x.refs_b[0] ?? x.refs_a[0] ?? "").localeCompare(
            y.refs_b[0] ?? y.refs_a[0] ?? "",
            undefined,
            { numeric: true },
        ),
    );
}
