/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Disposables, type IDisposable } from "../base/disposable";
import type { KicadPCB } from "../kicad";
import { Footprint } from "../kicad/board";
import { GlobalLabel, KicadSch, SchematicSymbol } from "../kicad/schematic";
import {
    KiCanvasLoadEvent,
    KiCanvasNetSelectEvent,
    KiCanvasSelectEvent,
} from "../viewers/base/events";
import type { BoardViewer } from "../viewers/board/viewer";
import {
    SheetConnectivity,
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

    /** The board net that a net on a sheet instance is part of. */
    board_net_for(page: ProjectPage, net: SheetNet): string | undefined {
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

        if (counts.size) {
            // If the board is out of sync with the schematic, go with the
            // majority.
            return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        }

        for (const name of this.#label_net_names(page, net)) {
            if (this.board.net_by_name(name)) {
                return name;
            }
        }

        return undefined;
    }

    /** Net names KiCad would give a net from its labels and power symbols */
    #label_net_names(page: ProjectPage, net: SheetNet) {
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

    /** Nets on a sheet instance that are part of the given board net. */
    sheet_nets_for(page: ProjectPage, name: string): SheetNet[] {
        const conn = SheetConnectivity.for(page.document as KicadSch);
        return conn.nets.filter((net) => this.board_net_for(page, net) == name);
    }

    /** Pages that have part of the given board net. */
    pages_with_net(name: string): ProjectPage[] {
        return this.pages.filter(
            (page) => this.sheet_nets_for(page, name).length > 0,
        );
    }
}

type ProbeState =
    | { kind: "net"; name: string }
    | { kind: "footprint"; footprint: Footprint }
    | null;

/**
 * Keeps a schematic viewer and a board viewer in sync, like KiCad's
 * cross-probing: selecting a symbol selects its footprint and the other way
 * around, and selecting a net highlights it in both. Always active.
 */
export class CrossProbe implements IDisposable {
    static pages_event = "kicanvas:cross-probe-pages";

    #disposables = new Disposables();
    #index: CrossProbeIndex | undefined;
    #busy = false;
    #state: ProbeState = null;

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
                    this.#on_schematic_net(e.detail.net as SheetNet | null),
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
                this.#guard(() =>
                    this.#set_state(
                        e.detail.net
                            ? { kind: "net", name: e.detail.net as string }
                            : null,
                    ),
                ),
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

    #on_schematic_select(item: unknown) {
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

    #on_schematic_net(net: SheetNet | null) {
        const page = this.schematic_page();
        const name = page && net ? this.index?.board_net_for(page, net) : null;
        if (name) {
            this.#set_state({ kind: "net", name });
        } else {
            this.#state = null;
            this.board_viewer.highlight_net(null);
            this.#announce_pages();
        }
    }

    #on_board_select(item: unknown) {
        if (item instanceof Footprint) {
            this.#set_state({ kind: "footprint", footprint: item });
        } else {
            this.#set_state(null);
        }
    }

    #set_state(state: ProbeState) {
        this.#state = state;

        if (state?.kind == "net") {
            this.board_viewer.highlight_net(state.name);
        }

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

        if (state?.kind == "net") {
            sv.highlight_nets(index.sheet_nets_for(page, state.name));
            return;
        }

        if (state?.kind == "footprint") {
            const placements = index.symbols_for(state.footprint);
            const here = placements.find((p) => p.page == page);
            if (here) {
                sv.select(here.symbol);
                if (sv.selected) {
                    sv.ensure_visible(sv.selected);
                }
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

    /** Tells the UI which sheets contain the probed net or part. */
    #announce_pages() {
        const index = this.index;
        const state = this.#state;
        let pages: ProjectPage[] = [];

        if (index && state?.kind == "net") {
            pages = index.pages_with_net(state.name);
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
