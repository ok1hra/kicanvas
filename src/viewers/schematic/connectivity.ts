/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox, Vec2 } from "../../base/math";
import {
    GlobalLabel,
    HierarchicalLabel,
    KicadSch,
    NetLabel,
    SchematicSheet,
    SchematicSheetPin,
    SchematicSymbol,
    type Wire,
} from "../../kicad/schematic";
import { PinPainter, type PinInfo } from "./painters/pin";
import { get_symbol_transform } from "./painters/symbol";

export type SheetLabel = NetLabel | GlobalLabel | HierarchicalLabel;

/** A symbol pin placed on a sheet. */
export class SheetPin {
    constructor(
        public symbol: SchematicSymbol,
        public number: string,
        /** Where wires connect to the pin */
        public position: Vec2,
        /** The other end of the pin's line */
        public end: Vec2,
        /** Electrical type, e.g. "power_in" or "no_connect" */
        public type: string,
    ) {}
}

/**
 * A set of items on one sheet that are connected to each other: wires,
 * labels, symbol pins and sheet pins. Items connect when they touch, and
 * labels and power symbols with the same name on a sheet connect.
 *
 * This doesn't follow connections across sheets. The names of nets come
 * from the board, see CrossProbe.
 */
export class SheetNet {
    wires: Wire[] = [];
    labels: SheetLabel[] = [];
    pins: SheetPin[] = [];
    sheet_pins: SchematicSheetPin[] = [];

    /** Power symbols (GND, +3V3, ...) connected to this net. */
    get power_symbols() {
        const symbols = new Set<SchematicSymbol>();
        for (const pin of this.pins) {
            if (pin.symbol.lib_symbol.power) {
                symbols.add(pin.symbol);
            }
        }
        return [...symbols];
    }

    /** Pins of regular (not power) symbols */
    get part_pins() {
        return this.pins.filter((p) => !p.symbol.lib_symbol.power);
    }

    get bbox() {
        const points: Vec2[] = [];
        for (const w of this.wires) {
            points.push(...w.pts);
        }
        for (const l of this.labels) {
            points.push(l.at.position);
        }
        for (const p of this.pins) {
            points.push(p.position, p.end);
        }
        for (const p of this.sheet_pins) {
            points.push(p.at.position);
        }
        return BBox.from_points(points);
    }
}

const key = (p: Vec2) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

/** Distance from p to the segment a-b */
function distance_to_segment(p: Vec2, a: Vec2, b: Vec2) {
    const ab = b.sub(a);
    const len2 = ab.x * ab.x + ab.y * ab.y;
    let t = len2 ? ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = p.x - (a.x + ab.x * t);
    const dy = p.y - (a.y + ab.y * t);
    return Math.sqrt(dx * dx + dy * dy);
}

class UnionFind {
    parent: number[] = [];

    add() {
        this.parent.push(this.parent.length);
        return this.parent.length - 1;
    }

    find(a: number): number {
        while (this.parent[a] != a) {
            this.parent[a] = this.parent[this.parent[a]!]!;
            a = this.parent[a]!;
        }
        return a;
    }

    union(a: number, b: number) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra != rb) {
            this.parent[rb] = ra;
        }
    }
}

const cache = new WeakMap<KicadSch, SheetConnectivity>();

/**
 * Connectivity of a single schematic sheet (file). The geometry is the same
 * for every instance of a sheet, so this is computed once per file.
 */
export class SheetConnectivity {
    nets: SheetNet[] = [];
    #net_by_pin = new Map<string, SheetNet>();

    static for(schematic: KicadSch) {
        let conn = cache.get(schematic);
        if (!conn) {
            conn = new SheetConnectivity(schematic);
            cache.set(schematic, conn);
        }
        return conn;
    }

    /** Pin positions for a placed symbol (all of its unit's pins). */
    static pins_of(symbol: SchematicSymbol): SheetPin[] {
        const transform = get_symbol_transform(symbol);
        const pins: SheetPin[] = [];

        for (const pin of symbol.unit_pins) {
            const def = pin.definition;
            if (!def) {
                continue;
            }

            const info: PinInfo = {
                pin: pin,
                def: def,
                position: def.at.position.copy(),
                orientation: "right",
            };
            info.orientation = (
                {
                    0: "right",
                    90: "up",
                    180: "left",
                    270: "down",
                } as const
            )[(((def.at.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270];

            PinPainter.apply_symbol_transformations(info, transform);

            const dir = {
                right: new Vec2(1, 0),
                left: new Vec2(-1, 0),
                up: new Vec2(0, -1),
                down: new Vec2(0, 1),
            }[info.orientation ?? "right"];

            pins.push(
                new SheetPin(
                    symbol,
                    pin.number,
                    info.position,
                    info.position.add(dir.multiply(def.length ?? 0)),
                    def.type,
                ),
            );
        }

        return pins;
    }

    constructor(public schematic: KicadSch) {
        const uf = new UnionFind();
        const at_point = new Map<string, number[]>();
        const add_point = (p: Vec2, node: number) => {
            const k = key(p);
            const list = at_point.get(k);
            if (list) {
                list.push(node);
            } else {
                at_point.set(k, [node]);
            }
        };

        type Node =
            | { kind: "wire"; item: Wire }
            | { kind: "label"; item: SheetLabel }
            | { kind: "pin"; item: SheetPin }
            | { kind: "sheet_pin"; item: SchematicSheetPin }
            | { kind: "junction" };
        const nodes: Node[] = [];
        const add_node = (node: Node) => {
            nodes.push(node);
            return uf.add();
        };

        const wire_nodes: [number, Wire][] = [];
        for (const wire of schematic.wires) {
            const n = add_node({ kind: "wire", item: wire });
            wire_nodes.push([n, wire]);
            for (const p of wire.pts) {
                add_point(p, n);
            }
        }

        for (const junction of schematic.junctions) {
            add_point(junction.at.position, add_node({ kind: "junction" }));
        }

        const labels_by_name = new Map<string, number[]>();
        for (const label of [
            ...schematic.net_labels,
            ...schematic.global_labels,
            ...schematic.hierarchical_labels,
        ]) {
            const n = add_node({ kind: "label", item: label });
            add_point(label.at.position, n);

            // Local and global labels with the same name on a sheet are
            // connected. Hierarchical labels only connect through the sheet
            // pin in the parent sheet.
            if (!(label instanceof HierarchicalLabel)) {
                const k = `${label.constructor.name}:${label.text}`;
                labels_by_name.set(k, [...(labels_by_name.get(k) ?? []), n]);
            }
        }

        const power_by_name = new Map<string, number[]>();
        const pin_symbol = new Map<number, SchematicSymbol>();
        for (const symbol of schematic.symbols.values()) {
            for (const pin of SheetConnectivity.pins_of(symbol)) {
                const n = add_node({ kind: "pin", item: pin });
                // No-connect pins never connect to anything.
                if (pin.type == "no_connect") {
                    continue;
                }
                pin_symbol.set(n, symbol);
                add_point(pin.position, n);
                // Power symbols name their net through a power input pin.
                // PWR_FLAG and similar have power outputs and don't.
                if (symbol.lib_symbol.power && pin.type == "power_in") {
                    const k = symbol.value;
                    power_by_name.set(k, [...(power_by_name.get(k) ?? []), n]);
                }
            }
        }

        for (const sheet of schematic.sheets) {
            for (const pin of sheet.pins) {
                add_point(
                    pin.at.position,
                    add_node({ kind: "sheet_pin", item: pin }),
                );
            }
        }

        // Things at the same point are connected, except for pins of one
        // symbol that are stacked on top of each other with nothing else
        // there.
        for (const list of at_point.values()) {
            const symbols = new Set(list.map((n) => pin_symbol.get(n)));
            if (symbols.size == 1 && !symbols.has(undefined)) {
                continue;
            }
            for (let i = 1; i < list.length; i++) {
                uf.union(list[0]!, list[i]!);
            }
        }

        // Things that touch the middle of a wire are connected to it.
        const points = [...at_point.entries()].map(([k, list]) => {
            const [x, y] = k.split(",").map((v) => parseInt(v, 10) / 1000);
            return { p: new Vec2(x!, y!), list };
        });
        for (const [n, wire] of wire_nodes) {
            const bbox = BBox.from_points(wire.pts).grow(0.001);
            for (const { p, list } of points) {
                if (!bbox.contains_point(p)) {
                    continue;
                }
                for (let i = 0; i < wire.pts.length - 1; i++) {
                    if (
                        distance_to_segment(p, wire.pts[i]!, wire.pts[i + 1]!) <
                        0.001
                    ) {
                        uf.union(n, list[0]!);
                        break;
                    }
                }
            }
        }

        for (const group of [
            ...labels_by_name.values(),
            ...power_by_name.values(),
        ]) {
            for (let i = 1; i < group.length; i++) {
                uf.union(group[0]!, group[i]!);
            }
        }

        // Collect the nets.
        const by_root = new Map<number, SheetNet>();
        nodes.forEach((node, i) => {
            if (node.kind == "junction") {
                return;
            }
            const root = uf.find(i);
            let net = by_root.get(root);
            if (!net) {
                net = new SheetNet();
                by_root.set(root, net);
                this.nets.push(net);
            }
            switch (node.kind) {
                case "wire":
                    net.wires.push(node.item);
                    break;
                case "label":
                    net.labels.push(node.item);
                    break;
                case "pin":
                    net.pins.push(node.item);
                    this.#net_by_pin.set(
                        `${node.item.symbol.uuid}:${node.item.number}`,
                        net,
                    );
                    break;
                case "sheet_pin":
                    net.sheet_pins.push(node.item);
                    break;
            }
        });
    }

    /** The net a symbol's pin is connected to. */
    net_for_pin(symbol: SchematicSymbol, number: string) {
        return this.#net_by_pin.get(`${symbol.uuid}:${number}`);
    }

    /**
     * Finds the net with a wire, pin or label at the given point.
     *
     * @param tolerance - how far from the item the point can be, in mm.
     */
    net_at(p: Vec2, tolerance: number): SheetNet | undefined {
        let best: SheetNet | undefined;
        let best_distance = Infinity;

        const consider = (net: SheetNet, distance: number) => {
            if (distance <= tolerance && distance < best_distance) {
                best = net;
                best_distance = distance;
            }
        };

        for (const net of this.nets) {
            for (const wire of net.wires) {
                for (let i = 0; i < wire.pts.length - 1; i++) {
                    consider(
                        net,
                        distance_to_segment(p, wire.pts[i]!, wire.pts[i + 1]!),
                    );
                }
            }
            for (const pin of net.pins) {
                consider(net, distance_to_segment(p, pin.position, pin.end));
            }
            for (const label of net.labels) {
                // Labels extend from their anchor along the text; a generous
                // radius around the anchor is a good enough approximation.
                const size = label.effects.font.size.y || 1.27;
                consider(
                    net,
                    Math.max(
                        0,
                        label.at.position.sub(p).magnitude - size * 1.5,
                    ),
                );
            }
            for (const pin of net.sheet_pins) {
                consider(net, pin.at.position.sub(p).magnitude);
            }
        }

        return best;
    }

    /** Nets that include any of the given sheet's pins */
    nets_for_sheet(sheet: SchematicSheet) {
        return this.nets.filter((n) =>
            n.sheet_pins.some((p) => p.parent == sheet),
        );
    }
}
