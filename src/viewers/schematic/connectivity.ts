/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox, Vec2 } from "../../base/math";
import {
    Bus,
    BusEntry,
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

/** Bus aliases: name to member names. */
export type BusAliases = Map<string, string[]>;

/** Splits a bus group's members, e.g. "A B[0..1], ~{C}". */
function split_members(text: string) {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const c of text) {
        if (c == "{" || c == "[") {
            depth++;
        } else if (c == "}" || c == "]") {
            depth--;
        }
        if (depth == 0 && (c == " " || c == ",")) {
            if (current) {
                parts.push(current);
            }
            current = "";
        } else {
            current += c;
        }
    }
    if (current) {
        parts.push(current);
    }
    return parts;
}

const vector_re = /^(.*)\[(\d+)\.\.(\d+)\](.*)$/;

/** The opening brace of a bus group, which isn't an overbar's "~{". */
function group_brace(text: string) {
    for (let i = 0; i < text.length; i++) {
        if (text[i] == "{" && text[i - 1] != "~") {
            return i;
        }
    }
    return -1;
}

/** Whether a label's text names a bus (rather than a net). */
export function is_bus_name(text: string, aliases?: BusAliases) {
    return (
        vector_re.test(text) ||
        (group_brace(text) >= 0 && text.endsWith("}")) ||
        !!aliases?.has(text)
    );
}

/**
 * The net names of a bus's members, like KiCad: "D[0..2]" is D0, D1 and
 * D2; "USB{DP DM}" is USB.DP and USB.DM; "{SDA SCL}" is SDA and SCL; and
 * an alias stands for its members.
 */
export function bus_members(
    text: string,
    aliases: BusAliases = new Map(),
    depth = 0,
): string[] {
    if (depth > 8) {
        return [];
    }

    const brace = group_brace(text);
    if (brace >= 0 && text.endsWith("}")) {
        const prefix = text.slice(0, brace);
        const members = split_members(text.slice(brace + 1, -1)).flatMap((m) =>
            is_bus_name(m, aliases) ? bus_members(m, aliases, depth + 1) : [m],
        );
        return prefix ? members.map((m) => `${prefix}.${m}`) : members;
    }

    const vector = vector_re.exec(text);
    if (vector) {
        const [, prefix, a, b, suffix] = vector;
        const start = parseInt(a!, 10);
        const end = parseInt(b!, 10);
        const step = start <= end ? 1 : -1;
        const names = [];
        for (let i = start; i != end + step; i += step) {
            names.push(`${prefix}${i}${suffix}`);
        }
        return names;
    }

    const alias = aliases.get(text);
    if (alias) {
        return alias.flatMap((m) =>
            is_bus_name(m, aliases) ? bus_members(m, aliases, depth + 1) : [m],
        );
    }

    return [];
}

/**
 * Connected bus wires on a sheet, with the labels and sheet pins that name
 * them and the bus entries that connect them to member nets.
 */
export class SheetBus {
    wires: Bus[] = [];
    entries: BusEntry[] = [];
    labels: SheetLabel[] = [];
    sheet_pins: SchematicSheetPin[] = [];

    /** Names of the bus: the texts of its labels and sheet pins. */
    get names(): string[] {
        return [
            ...new Set([
                ...this.labels.map((l) => l.text),
                ...this.sheet_pins.map((p) => p.name),
            ]),
        ];
    }

    /** The net names of the bus's members. */
    members(aliases?: BusAliases): string[] {
        return [...new Set(this.names.flatMap((n) => bus_members(n, aliases)))];
    }

    get bbox() {
        const points: Vec2[] = [];
        for (const w of this.wires) {
            points.push(...w.pts);
        }
        for (const e of this.entries) {
            points.push(e.at.position, e.at.position.add(e.size));
        }
        for (const l of this.labels) {
            points.push(l.at.position);
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
    buses: SheetBus[] = [];
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
        const { bus_labels, bus_pins } = this.#find_buses(schematic);

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
            // Labels of buses aren't nets.
            if (bus_labels.has(label)) {
                continue;
            }
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
                if (bus_pins.has(pin)) {
                    continue;
                }
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

    /**
     * Groups bus wires that touch, and finds their labels, sheet pins and
     * bus entries.
     */
    #find_buses(schematic: KicadSch) {
        const bus_labels = new Set<SheetLabel>();
        const bus_pins = new Set<SchematicSheetPin>();
        const wires = schematic.buses ?? [];

        const on_wire = (p: Vec2, wire: Bus) => {
            for (let i = 0; i < wire.pts.length - 1; i++) {
                if (
                    distance_to_segment(p, wire.pts[i]!, wire.pts[i + 1]!) <
                    0.001
                ) {
                    return true;
                }
            }
            return false;
        };

        // Wires that touch are one bus.
        const uf = new UnionFind();
        wires.forEach(() => uf.add());
        for (let i = 0; i < wires.length; i++) {
            for (let j = i + 1; j < wires.length; j++) {
                const a = wires[i]!;
                const b = wires[j]!;
                if (
                    a.pts.some((p) => on_wire(p, b)) ||
                    b.pts.some((p) => on_wire(p, a))
                ) {
                    uf.union(i, j);
                }
            }
        }
        const by_root = new Map<number, SheetBus>();
        const bus_of_wire = wires.map((wire, i) => {
            const root = uf.find(i);
            let bus = by_root.get(root);
            if (!bus) {
                bus = new SheetBus();
                by_root.set(root, bus);
                this.buses.push(bus);
            }
            bus.wires.push(wire);
            return bus;
        });
        const bus_at = (p: Vec2) => {
            const i = wires.findIndex((w) => on_wire(p, w));
            return i >= 0 ? bus_of_wire[i] : undefined;
        };

        for (const label of [
            ...schematic.net_labels,
            ...schematic.global_labels,
            ...schematic.hierarchical_labels,
        ]) {
            const bus = bus_at(label.at.position);
            if (bus) {
                bus.labels.push(label);
                bus_labels.add(label);
            } else if (is_bus_name(label.text)) {
                // A bus label that isn't on a bus wire.
                bus_labels.add(label);
            }
        }

        for (const sheet of schematic.sheets) {
            for (const pin of sheet.pins) {
                const bus = bus_at(pin.at.position);
                if (bus) {
                    bus.sheet_pins.push(pin);
                    bus_pins.add(pin);
                } else if (is_bus_name(pin.name)) {
                    bus_pins.add(pin);
                }
            }
        }

        for (const entry of schematic.bus_entries ?? []) {
            const bus =
                bus_at(entry.at.position) ??
                bus_at(entry.at.position.add(entry.size));
            bus?.entries.push(entry);
        }

        return { bus_labels, bus_pins };
    }

    /**
     * Finds the net or bus nearest to the given point, within tolerance.
     */
    item_at(p: Vec2, tolerance: number): { net?: SheetNet; bus?: SheetBus } {
        const net = this.#nearest_net(p, tolerance);
        let bus: SheetBus | undefined;
        let bus_distance = Infinity;
        for (const b of this.buses) {
            for (const wire of b.wires) {
                for (let i = 0; i < wire.pts.length - 1; i++) {
                    const d = distance_to_segment(
                        p,
                        wire.pts[i]!,
                        wire.pts[i + 1]!,
                    );
                    if (d <= tolerance && d < bus_distance) {
                        bus = b;
                        bus_distance = d;
                    }
                }
            }
            for (const label of b.labels) {
                const size = label.effects.font.size.y || 1.27;
                const d = Math.max(
                    0,
                    label.at.position.sub(p).magnitude - size * 1.5,
                );
                if (d <= tolerance && d < bus_distance) {
                    bus = b;
                    bus_distance = d;
                }
            }
        }
        if (bus && (!net.net || bus_distance < net.distance)) {
            return { bus };
        }
        return { net: net.net };
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
        return this.#nearest_net(p, tolerance).net;
    }

    #nearest_net(p: Vec2, tolerance: number) {
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

        return { net: best, distance: best_distance };
    }

    /** Nets that include any of the given sheet's pins */
    nets_for_sheet(sheet: SchematicSheet) {
        return this.nets.filter((n) =>
            n.sheet_pins.some((p) => p.parent == sheet),
        );
    }
}
