/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Disposables, type IDisposable } from "../base/disposable";
import { BBox } from "../base/math";
import type { KicadPCB } from "../kicad";
import { Footprint } from "../kicad/board";
import {
    GlobalLabel,
    HierarchicalLabel,
    KicadSch,
    SchematicSheet,
    SchematicSymbol,
} from "../kicad/schematic";
import {
    KiCanvasLoadEvent,
    KiCanvasNetSelectEvent,
    KiCanvasSelectEvent,
} from "../viewers/base/events";
import type { BoardViewer } from "../viewers/board/viewer";
import {
    SheetConnectivity,
    bus_members,
    type BusAliases,
    type SheetBus,
    type SheetNet,
} from "../viewers/schematic/connectivity";
import type { SchematicViewer } from "../viewers/schematic/viewer";
import type { Project, ProjectPage } from "./project";

/**
 * The `path` KiCad stores in a footprint for a symbol in a sheet instance:
 * the UUIDs of the sheets below the root, then the symbol's UUID.
 */
export function footprint_path(page: ProjectPage, symbol: SchematicSymbol) {
    const sheets = page.sheet_path.split("/").filter(Boolean).slice(1);
    return `/${[...sheets, symbol.uuid].join("/")}`;
}

/**
 * A symbol's reference in a sheet instance. Unlike symbol.reference, this
 * doesn't depend on which instance of the sheet was last shown.
 */
export function reference_in(page: ProjectPage, symbol: SchematicSymbol) {
    return symbol.instances.get(page.sheet_path)?.reference ?? symbol.reference;
}

/**
 * Maps between schematic symbols and board footprints, and between nets on
 * schematic sheets and board nets.
 *
 * Nets are named by the board: a sheet net's name is the net of the pads
 * its pins are connected to. That's exact for nets with pins, and for nets
 * without pins it falls back to KiCad's naming of labels and power symbols.
 */
export class CrossProbeIndex {
    #fp_by_path = new Map<string, Footprint>();
    #fp_by_ref = new Map<string, Footprint>();

    constructor(
        public project: Project,
        public board: KicadPCB,
    ) {
        for (const fp of board.footprints) {
            if (fp.path) {
                this.#fp_by_path.set(fp.path, fp);
            }
            if (fp.reference) {
                this.#fp_by_ref.set(fp.reference, fp);
            }
        }
    }

    /** Schematic pages that are part of the sheet hierarchy. */
    get pages(): ProjectPage[] {
        return [...this.project.pages()].filter(
            (p) =>
                p.type == "schematic" &&
                (p.page !== undefined || p == this.project.root_schematic_page),
        );
    }

    footprint_for(
        page: ProjectPage,
        symbol: SchematicSymbol,
    ): Footprint | undefined {
        return (
            this.#fp_by_path.get(footprint_path(page, symbol)) ??
            this.#fp_by_ref.get(reference_in(page, symbol))
        );
    }

    /** All placements of a footprint's symbol (several for multi-unit parts) */
    symbols_for(
        fp: Footprint,
    ): { page: ProjectPage; symbol: SchematicSymbol }[] {
        const found: { page: ProjectPage; symbol: SchematicSymbol }[] = [];

        // The footprint's path points at one of the symbol's units.
        const parts = fp.path?.split("/").filter(Boolean) ?? [];
        const root = this.project.root_schematic_page;
        if (parts.length && root) {
            const sheet_path = [root.sheet_path, ...parts.slice(0, -1)].join(
                "/",
            );
            const page = this.project.page_by_sheet_path(sheet_path);
            const symbol = (
                page?.document as KicadSch | undefined
            )?.symbols.get(parts.at(-1)!);
            if (page && symbol) {
                found.push({ page, symbol });
            }
        }

        // Other units have the same reference.
        for (const page of this.pages) {
            for (const symbol of (page.document as KicadSch).symbols.values()) {
                if (
                    !symbol.lib_symbol.power &&
                    reference_in(page, symbol) == fp.reference &&
                    !found.some((f) => f.page == page && f.symbol == symbol)
                ) {
                    found.push({ page, symbol });
                }
            }
        }

        return found;
    }

    #groups?: NetGroups;

    /** Nets across the sheet hierarchy, see NetGroups. */
    get groups(): NetGroups {
        if (!this.#groups) {
            this.#groups = new NetGroups(this);
        }
        return this.#groups;
    }

    /**
     * A name for the whole net (across sheets) that a net on a sheet
     * instance is part of: the board net's name if there is one, otherwise
     * a made up "#<n>" name.
     */
    net_key(page: ProjectPage, net: SheetNet): string | undefined {
        return this.groups.key(page, net);
    }

    /** The board net that a net on a sheet instance is part of. */
    board_net_for(page: ProjectPage, net: SheetNet): string | undefined {
        const key = this.net_key(page, net);
        return key && !NetGroups.is_made_up(key) ? key : undefined;
    }

    /** The board net of a sheet net, from its pins only. */
    pin_net_for(page: ProjectPage, net: SheetNet): Map<string, number> {
        const counts = new Map<string, number>();
        for (const pin of net.part_pins) {
            const pad = this.footprint_for(page, pin.symbol)?.pad_by_number(
                pin.number,
            );
            const name = pad?.net?.name;
            if (name) {
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
        }
        return counts;
    }

    /** Net names KiCad would give a net from its labels and power symbols */
    label_net_names(page: ProjectPage, net: SheetNet) {
        const names: string[] = [];
        const sheet = this.project.human_sheet_path(page.sheet_path);
        for (const symbol of net.power_symbols) {
            names.push(symbol.value);
        }
        for (const label of net.labels) {
            if (label instanceof GlobalLabel) {
                names.push(label.text);
            } else {
                names.push(`${sheet}${label.text}`);
            }
        }
        return names;
    }

    /** Nets on a sheet instance that are part of the given net (key). */
    sheet_nets_for(page: ProjectPage, key: string): SheetNet[] {
        const conn = SheetConnectivity.for(page.document as KicadSch);
        return conn.nets.filter((net) => this.net_key(page, net) == key);
    }

    /** Pages that have part of the given net (key). */
    pages_with_net(key: string): ProjectPage[] {
        return this.pages.filter(
            (page) => this.sheet_nets_for(page, key).length > 0,
        );
    }

    #member_keys = new Map<string, string[]>();

    /**
     * The nets (keys) of a bus member, by name: nets with a label of that
     * name on the sheet, or on the sheets the bus continues to through
     * sheet pins and hierarchical labels. Otherwise the board net KiCad
     * would name after it.
     */
    member_keys(page: ProjectPage, member: string): string[] {
        const cache_key = `${page.project_path}\n${member}`;
        const cached = this.#member_keys.get(cache_key);
        if (cached) {
            return cached;
        }

        const keys = new Set<string>();
        const visited = new Set<ProjectPage>();
        const queue = [page];
        const aliases = this.aliases;
        while (queue.length) {
            const p = queue.shift()!;
            if (visited.has(p)) {
                continue;
            }
            visited.add(p);

            const conn = SheetConnectivity.for(p.document as KicadSch);
            for (const net of conn.nets) {
                if (net.labels.some((l) => l.text == member)) {
                    const key = this.net_key(p, net);
                    if (key) {
                        keys.add(key);
                    }
                }
            }

            // Follow the buses that carry the member to other sheets.
            for (const bus of conn.buses) {
                if (!bus.members(aliases).includes(member)) {
                    continue;
                }
                for (const pin of bus.sheet_pins) {
                    const child = this.project.page_by_sheet_path(
                        `${p.sheet_path}/${pin.parent.uuid}`,
                    );
                    if (child) {
                        queue.push(child);
                    }
                }
                if (bus.labels.some((l) => l instanceof HierarchicalLabel)) {
                    const parent = this.#parent_page(p);
                    if (parent) {
                        queue.push(parent);
                    }
                }
            }
        }

        if (!keys.size) {
            const sheet = this.project.human_sheet_path(page.sheet_path);
            for (const name of [`${sheet}${member}`, member]) {
                if (this.board.net_by_name(name)) {
                    keys.add(name);
                    break;
                }
            }
        }

        const result = [...keys];
        this.#member_keys.set(cache_key, result);
        return result;
    }

    #parent_page(page: ProjectPage) {
        const parts = page.sheet_path.split("/").filter(Boolean);
        return parts.length > 1
            ? this.project.page_by_sheet_path(
                  `/${parts.slice(0, -1).join("/")}`,
              )
            : undefined;
    }

    /** Buses on a sheet instance with any of the given nets (keys). */
    sheet_buses_for(page: ProjectPage, keys: Set<string>): SheetBus[] {
        const conn = SheetConnectivity.for(page.document as KicadSch);
        const aliases = this.aliases;
        return conn.buses.filter((bus) =>
            bus
                .members(aliases)
                .some((m) =>
                    this.member_keys(page, m).some((k) => keys.has(k)),
                ),
        );
    }

    #aliases?: BusAliases;

    get aliases(): BusAliases {
        this.#aliases ??= this.project.bus_aliases;
        return this.#aliases;
    }
}

/**
 * Nets across the sheet hierarchy. Nets on sheets are connected through
 * sheet pins and hierarchical labels, global labels, power symbols and
 * bus members, like in KiCad's netlist.
 *
 * Each connected group is named after the board net that most of its pins'
 * pads are on. Groups without pins on the board are named after their
 * labels, like KiCad would, or get a made up name.
 */
export class NetGroups {
    #ids = new Map<ProjectPage, Map<SheetNet, number>>();
    #keys: string[] = [];

    static is_made_up(key: string) {
        return key.startsWith("#");
    }

    constructor(index: CrossProbeIndex) {
        const project = index.project;
        const pages = index.pages;
        const uf = new UnionFind();
        const refs: { page: ProjectPage; net: SheetNet }[] = [];

        for (const page of pages) {
            const ids = new Map<SheetNet, number>();
            for (const net of SheetConnectivity.for(page.document as KicadSch)
                .nets) {
                ids.set(net, uf.add());
                refs.push({ page, net });
            }
            this.#ids.set(page, ids);
        }

        const id = (page: ProjectPage, net: SheetNet) =>
            this.#ids.get(page)!.get(net)!;
        const join_by = new Map<string, number>();
        const join = (name: string, n: number) => {
            const other = join_by.get(name);
            if (other === undefined) {
                join_by.set(name, n);
            } else {
                uf.union(other, n);
            }
        };

        for (const { page, net } of refs) {
            const n = id(page, net);
            for (const label of net.labels) {
                if (label instanceof GlobalLabel) {
                    join(`global:${label.text}`, n);
                }
            }
            for (const pin of net.pins) {
                if (pin.symbol.lib_symbol.power && pin.type == "power_in") {
                    join(`global:${pin.symbol.value}`, n);
                }
            }
        }

        // Sheet pins connect to the hierarchical labels in the sheet.
        const aliases = index.aliases;
        for (const page of pages) {
            const doc = page.document as KicadSch;
            const conn = SheetConnectivity.for(doc);
            for (const sheet of doc.sheets) {
                const child = project.page_by_sheet_path(
                    `${page.sheet_path}/${sheet.uuid}`,
                );
                const child_ids = child && this.#ids.get(child);
                if (!child || !child_ids) {
                    continue;
                }
                const child_conn = SheetConnectivity.for(
                    child.document as KicadSch,
                );
                for (const net of conn.nets_for_sheet(sheet)) {
                    for (const pin of net.sheet_pins) {
                        if (pin.parent != sheet) {
                            continue;
                        }
                        for (const child_net of child_conn.nets) {
                            if (
                                child_net.labels.some(
                                    (l) =>
                                        l instanceof HierarchicalLabel &&
                                        l.text == pin.name,
                                )
                            ) {
                                uf.union(id(page, net), id(child, child_net));
                            }
                        }
                    }
                }

                // Bus pins connect the bus members on both sides.
                for (const bus of conn.buses) {
                    for (const pin of bus.sheet_pins) {
                        if (pin.parent != sheet) {
                            continue;
                        }
                        for (const member of bus_members(pin.name, aliases)) {
                            const here = conn.nets.filter((n) =>
                                n.labels.some((l) => l.text == member),
                            );
                            const there = child_conn.nets.filter((n) =>
                                n.labels.some((l) => l.text == member),
                            );
                            for (const a of here) {
                                for (const b of there) {
                                    uf.union(id(page, a), id(child, b));
                                }
                            }
                        }
                    }
                }
            }
        }

        // Name the groups.
        const members = new Map<
            number,
            { page: ProjectPage; net: SheetNet }[]
        >();
        for (const ref of refs) {
            const root = uf.find(id(ref.page, ref.net));
            members.set(root, [...(members.get(root) ?? []), ref]);
        }
        const key_by_root = new Map<number, string>();
        for (const [root, list] of members) {
            key_by_root.set(root, NetGroups.#name(index, list, root));
        }
        for (const ref of refs) {
            const n = id(ref.page, ref.net);
            this.#keys[n] = key_by_root.get(uf.find(n))!;
        }
    }

    static #name(
        index: CrossProbeIndex,
        list: { page: ProjectPage; net: SheetNet }[],
        root: number,
    ) {
        const counts = new Map<string, number>();
        for (const { page, net } of list) {
            for (const [name, count] of index.pin_net_for(page, net)) {
                counts.set(name, (counts.get(name) ?? 0) + count);
            }
        }
        if (counts.size) {
            // If the board is out of sync with the schematic, go with the
            // majority.
            return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        }

        // Labels on higher level sheets name the net.
        const by_depth = [...list].sort(
            (a, b) => a.page.sheet_path.length - b.page.sheet_path.length,
        );
        for (const { page, net } of by_depth) {
            for (const name of index.label_net_names(page, net)) {
                if (index.board.net_by_name(name)) {
                    return name;
                }
            }
        }

        return `#${root}`;
    }

    key(page: ProjectPage, net: SheetNet): string | undefined {
        const n = this.#ids.get(page)?.get(net);
        return n === undefined ? undefined : this.#keys[n];
    }
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

type ProbeState =
    | {
          kind: "nets";
          /** Nets by key, see CrossProbeIndex.net_key() */
          keys: string[];
      }
    | { kind: "footprint"; footprint: Footprint }
    | null;

/**
 * Keeps a schematic viewer and a board viewer in sync, like KiCad's
 * cross-probing: selecting a symbol selects its footprint and the other way
 * around, and selecting a net (or nets of a bus) highlights it in both, on
 * every sheet it's on. Always active.
 */
export class CrossProbe implements IDisposable {
    static pages_event = "kicanvas:cross-probe-pages";

    #disposables = new Disposables();
    #index: CrossProbeIndex | undefined;
    #busy = false;
    #state: ProbeState = null;
    /** Zoom to the probe when it's next shown in the schematic. */
    #zoom_schematic = false;

    /**
     * Selects a part in both views and zooms to it, switching to its
     * sheet if needed. Used by search.
     */
    probe_part(footprint: Footprint) {
        this.#guard(() => {
            this.#state = { kind: "footprint", footprint };
            this.board_viewer.select(footprint);
            this.board_viewer.zoom_to_item(footprint.bbox);
            this.#zoom_schematic = true;
            this.#apply_to_schematic(false);
            this.#announce_pages();
        });
    }

    /**
     * Highlights a net in both views and zooms to it. The schematic shows
     * the first sheet with the net if the current one doesn't have it.
     */
    probe_net(name: string) {
        this.#guard(() => {
            this.#set_nets([name], { board: true, schematic: true });
        });
    }

    /** The probed nets (keys), if nets are probed. */
    get net_keys(): readonly string[] {
        return this.#state?.kind == "nets" ? this.#state.keys : [];
    }

    constructor(
        public project: Project,
        public schematic_viewer: SchematicViewer,
        public board_viewer: BoardViewer,
        /** Returns the page shown in the schematic viewer */
        public schematic_page: () => ProjectPage | undefined,
    ) {
        const sv = schematic_viewer;
        const bv = board_viewer;

        this.#disposables.add(
            sv.addEventListener(KiCanvasSelectEvent.type, (e) =>
                this.#guard(() => this.#on_schematic_select(e.detail.item)),
            ),
        );
        this.#disposables.add(
            sv.addEventListener(KiCanvasNetSelectEvent.type, (e) =>
                this.#guard(() =>
                    this.#on_schematic_nets(
                        (e.detail.nets ??
                            (e.detail.net ? [e.detail.net] : [])) as SheetNet[],
                        e.detail.members,
                    ),
                ),
            ),
        );
        this.#disposables.add(
            bv.addEventListener(KiCanvasSelectEvent.type, (e) =>
                this.#guard(() => this.#on_board_select(e.detail.item)),
            ),
        );
        this.#disposables.add(
            bv.addEventListener(KiCanvasNetSelectEvent.type, (e) =>
                this.#guard(() => {
                    const name = e.detail.net as string | null;
                    if (name) {
                        // Show it in the schematic, on another sheet if
                        // needed.
                        this.#set_nets([name], { schematic: true });
                    } else {
                        this.#clear();
                    }
                }),
            ),
        );
        // Apply the current probe to whichever sheet is shown next.
        this.#disposables.add(
            sv.addEventListener(KiCanvasLoadEvent.type, () =>
                this.#guard(() => this.#apply_to_schematic(true)),
            ),
        );
    }

    dispose() {
        this.#disposables.dispose();
    }

    get index(): CrossProbeIndex | undefined {
        if (!this.#index) {
            const board = this.board_viewer.board;
            if (board) {
                this.#index = new CrossProbeIndex(this.project, board);
            }
        }
        return this.#index;
    }

    #guard(fn: () => void) {
        if (this.#busy) {
            return;
        }
        this.#busy = true;
        try {
            fn();
        } catch (e) {
            console.error("Cross-probing failed", e);
        } finally {
            this.#busy = false;
        }
    }

    #clear() {
        this.#state = null;
        this.board_viewer.highlight_net(null);
        this.#apply_to_schematic(false);
        this.#announce_pages();
    }

    #on_schematic_select(item: unknown) {
        // Selecting a sheet symbol (e.g. on the way into the sheet) keeps
        // the probe.
        if (item instanceof SchematicSheet) {
            return;
        }

        const page = this.schematic_page();
        const index = this.index;
        if (!page || !index) {
            return;
        }

        if (item instanceof SchematicSymbol) {
            const fp = index.footprint_for(page, item);
            if (fp) {
                this.#state = { kind: "footprint", footprint: fp };
                this.board_viewer.select(fp);
                this.board_viewer.ensure_visible(fp.bbox);
                this.#announce_pages();
                return;
            }
        }

        this.#state = null;
        this.board_viewer.select(null);
        this.#announce_pages();
    }

    #on_schematic_nets(nets: SheetNet[], members?: string[]) {
        const page = this.schematic_page();
        const index = this.index;
        const keys = new Set<string>();
        if (page && index) {
            for (const net of nets) {
                const key = index.net_key(page, net);
                if (key) {
                    keys.add(key);
                }
            }
            for (const member of members ?? []) {
                for (const key of index.member_keys(page, member)) {
                    keys.add(key);
                }
            }
        }

        if (keys.size) {
            // The schematic already shows the clicked nets; show them on
            // the board.
            this.#set_nets([...keys], { board: true });
        } else if (nets.length || members?.length) {
            // Nothing to show elsewhere; the schematic keeps its highlight.
            this.#state = null;
            this.board_viewer.highlight_net(null);
            this.#announce_pages();
        } else {
            this.#clear();
        }
    }

    #on_board_select(item: unknown) {
        if (item instanceof Footprint) {
            this.#state = { kind: "footprint", footprint: item };
            this.#apply_to_schematic(false);
            this.#announce_pages();
        } else {
            this.#state = null;
            this.#apply_to_schematic(false);
            this.#announce_pages();
        }
    }

    /**
     * Highlights nets in both views.
     *
     * @param zoom - which views to zoom to the nets; the schematic also
     *     switches to a sheet with the nets if the shown one has none.
     */
    #set_nets(keys: string[], zoom: { board?: boolean; schematic?: boolean }) {
        this.#state = { kind: "nets", keys };

        const bv = this.board_viewer;
        bv.highlight_nets(keys);
        if (zoom.board) {
            const bbox = bv.net_bbox(keys);
            if (bbox.valid) {
                bv.zoom_to_item(bbox);
            }
        }

        this.#zoom_schematic = !!zoom.schematic;
        this.#apply_to_schematic(false);
        this.#announce_pages();
    }

    /**
     * Shows the current probe in the schematic. For footprints, switches to
     * the sheet with the symbol if it isn't on the current one.
     */
    #apply_to_schematic(sheet_changed: boolean) {
        const sv = this.schematic_viewer;
        const page = this.schematic_page();
        const index = this.index;
        const state = this.#state;

        if (!page || !index || !sv.document) {
            return;
        }

        if (state?.kind == "nets") {
            const nets = state.keys.flatMap((k) =>
                index.sheet_nets_for(page, k),
            );
            const buses = index.sheet_buses_for(page, new Set(state.keys));
            if (!nets.length && this.#zoom_schematic && !sheet_changed) {
                // Show a sheet that has the nets; applied again once loaded.
                const other = state.keys
                    .map((k) => index.pages_with_net(k)[0])
                    .find((p) => p);
                if (other) {
                    this.project.set_active_page(other);
                    return;
                }
            }
            sv.highlight_nets(nets, false, buses);
            if (this.#zoom_schematic && nets.length) {
                sv.zoom_to_item(BBox.combine(nets.map((n) => n.bbox)));
            }
            this.#zoom_schematic = false;
            return;
        }

        if (state?.kind == "footprint") {
            const placements = index.symbols_for(state.footprint);
            const here = placements.find((p) => p.page == page);
            if (here) {
                sv.select(here.symbol);
                // Show the part with its surroundings.
                if (sv.selected) {
                    sv.zoom_to_item(sv.selected);
                }
                this.#zoom_schematic = false;
            } else if (placements.length && !sheet_changed) {
                // Show the sheet; this is applied again once it's loaded.
                this.project.set_active_page(placements[0]!.page);
            } else {
                sv.select(null);
            }
            return;
        }

        if (!sheet_changed) {
            sv.select(null);
        }
    }

    /** Tells the UI which sheets contain the probed nets or part. */
    #announce_pages() {
        const index = this.index;
        const state = this.#state;
        let pages: ProjectPage[] = [];

        if (index && state?.kind == "nets") {
            pages = [
                ...new Set(state.keys.flatMap((k) => index.pages_with_net(k))),
            ];
        } else if (index && state?.kind == "footprint") {
            pages = index.symbols_for(state.footprint).map((p) => p.page);
        }

        window.dispatchEvent(
            new CustomEvent(CrossProbe.pages_event, {
                detail: new Set(pages.map((p) => p.project_path)),
            }),
        );
    }
}
