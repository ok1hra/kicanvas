/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { KicadPCB } from "../kicad";
import type { Footprint } from "../kicad/board";
import {
    instance_for,
    type KicadSch,
    type SchematicSymbol,
} from "../kicad/schematic";
import { reference_in, type CrossProbeIndex } from "./cross-probe";
import type { Project, ProjectPage } from "./project";

export type PartSearchItem = {
    kind: "part";
    reference: string;
    value: string;
    id?: string;
    mpn?: string;
    footprint?: Footprint;
    page?: ProjectPage;
    symbol?: SchematicSymbol;
};

export type NetSearchItem = { kind: "net"; name: string };

export type SearchItem = PartSearchItem | NetSearchItem;

function field(symbol: SchematicSymbol | undefined, name: string) {
    const value = symbol?.properties.get(name)?.text?.trim();
    return value || undefined;
}

/**
 * Everything that can be searched for: parts (from the board, plus
 * schematic symbols that aren't on it) and nets.
 */
export function build_search_items(
    project: Project,
    board?: KicadPCB,
    index?: CrossProbeIndex,
): SearchItem[] {
    const parts = new Map<string, PartSearchItem>();

    for (const fp of board?.footprints ?? []) {
        if (!fp.reference) {
            continue;
        }
        const placement = index?.symbols_for(fp)[0];
        const prop = (name: string) =>
            fp.properties[name]?.value?.trim() ||
            field(placement?.symbol, name);
        parts.set(fp.reference, {
            kind: "part",
            reference: fp.reference,
            value: fp.value ?? "",
            id: prop("ID"),
            mpn: prop("part_value"),
            footprint: fp,
            page: placement?.page,
            symbol: placement?.symbol,
        });
    }

    const pages = index
        ? index.pages
        : [...project.pages()].filter((p) => p.type == "schematic");
    for (const page of pages) {
        for (const symbol of (page.document as KicadSch).symbols.values()) {
            if (symbol.lib_symbol.power) {
                continue;
            }
            const reference = reference_in(page, symbol);
            if (!reference || reference.includes("?") || parts.has(reference)) {
                continue;
            }
            parts.set(reference, {
                kind: "part",
                reference,
                value:
                    instance_for(symbol.instances, page.sheet_path)?.value ??
                    symbol.value ??
                    "",
                id: field(symbol, "ID"),
                mpn: field(symbol, "part_value"),
                page,
                symbol,
            });
        }
    }

    const nets: NetSearchItem[] = (board?.nets ?? [])
        .filter((n) => n.name)
        .map((n) => ({ kind: "net", name: n.name }));

    return [...parts.values(), ...nets];
}

function searchable(item: SearchItem): string[] {
    return item.kind == "part"
        ? [item.reference, item.id, item.mpn, item.value].filter(
              (s): s is string => !!s,
          )
        : [item.name];
}

const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

/**
 * Items with a field containing the query (ignoring case): exact matches
 * first, then prefix matches, then the rest; parts before nets.
 */
export function search(
    items: SearchItem[],
    query: string,
    limit = 50,
): SearchItem[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
        return [];
    }

    const scored: { item: SearchItem; score: number }[] = [];
    for (const item of items) {
        let score = Infinity;
        for (const text of searchable(item)) {
            const t = text.toLowerCase();
            if (t == q) {
                score = Math.min(score, 0);
            } else if (t.startsWith(q)) {
                score = Math.min(score, 1);
            } else if (t.includes(q)) {
                score = Math.min(score, 2);
            }
        }
        if (score < Infinity) {
            scored.push({ item, score });
        }
    }

    const name = (i: SearchItem) => (i.kind == "part" ? i.reference : i.name);
    scored.sort(
        (a, b) =>
            a.score - b.score ||
            (a.item.kind == b.item.kind ? 0 : a.item.kind == "part" ? -1 : 1) ||
            collator.compare(name(a.item), name(b.item)),
    );

    return scored.slice(0, limit).map((s) => s.item);
}
