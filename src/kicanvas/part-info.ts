/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { Footprint } from "../kicad/board";
import { instance_for, type SchematicSymbol } from "../kicad/schematic";
import { reference_in } from "./cross-probe";
import type { ProjectPage } from "./project";

export type PartField = { name: string; value: string };

/** Fields shown before "Show all", in this order. */
export const key_fields = ["ID", "Datasheet", "part_value"];

/** A row of the part info card: one value and the fields that have it. */
export type PartRow = {
    names: string[];
    value: string | undefined;
    key: boolean;
};

/**
 * Whether two fields with this value are likely the same text repeated,
 * e.g. a description copied into another field. Short values like "0" or
 * "yes" are equal by coincidence.
 */
function is_text(value: string | undefined) {
    const v = value?.trim() ?? "";
    return v.length >= 6 && /\p{L}/u.test(v);
}

/** Link to a part in Factorify, by its ID field. */
export function factorify_href(id: string | undefined): string | undefined {
    const v = id?.trim();
    return v && /^\d+$/.test(v)
        ? `https://prusa3d.factorify.cz/ui/goods/${v}`
        : undefined;
}

/**
 * The metadata of a part (component): its symbol's fields, plus a few
 * things from its footprint and where it is in the schematic.
 */
export class PartInfo {
    constructor(
        public reference: string,
        public value: string,
        public fields: PartField[],
    ) {}

    /**
     * The card's rows: the key fields first, then the other fields except
     * the reference. Fields with the same value as an earlier row (e.g. a
     * "req" field repeating the description) are merged into that row.
     */
    rows(): PartRow[] {
        const rows: PartRow[] = key_fields.map((name) => ({
            names: [name],
            value: this.get(name),
            key: true,
        }));
        const lower_keys = key_fields.map((k) => k.toLowerCase());

        for (const f of this.fields) {
            const lower = f.name.toLowerCase();
            if (f.name == "Reference" || lower_keys.includes(lower)) {
                continue;
            }
            const same = !is_text(f.value)
                ? undefined
                : rows.find(
                      (r) =>
                          is_text(r.value) && r.value!.trim() == f.value.trim(),
                  );
            if (same) {
                same.names.push(f.name);
            } else {
                rows.push({ names: [f.name], value: f.value, key: false });
            }
        }
        return rows;
    }

    /** Looks up a field by name, ignoring case. */
    get(name: string): string | undefined {
        const lower = name.toLowerCase();
        return this.fields.find((f) => f.name.toLowerCase() == lower)?.value;
    }

    static from_symbol(
        page: ProjectPage,
        symbol: SchematicSymbol,
        footprint?: Footprint,
    ): PartInfo {
        const reference = reference_in(page, symbol);
        const instance = instance_for(symbol.instances, page.sheet_path);
        const fields: PartField[] = [];
        const add = (name: string, value: string | undefined) => {
            if (value !== undefined) {
                fields.push({ name, value });
            }
        };

        for (const prop of symbol.properties.values()) {
            switch (prop.name) {
                case "Reference":
                    add(prop.name, reference);
                    break;
                case "Value":
                    add(prop.name, instance?.value ?? prop.shown_text);
                    break;
                case "Footprint":
                    add(prop.name, instance?.footprint ?? prop.shown_text);
                    break;
                default:
                    add(prop.name, prop.shown_text);
            }
        }

        add("Library symbol", symbol.lib_id);
        if (symbol.lib_symbol.unit_count > 1) {
            add("Unit", symbol.unit_suffix || `${symbol.unit ?? 1}`);
        }
        add("Sheet", page.project.human_sheet_path(page.sheet_path));
        add("Sheet file", page.filename);
        if (symbol.dnp) {
            add("Do not populate", "yes");
        }
        if (symbol.in_bom === false) {
            add("Exclude from BOM", "yes");
        }
        if (footprint) {
            PartInfo.#add_board_fields(footprint, add, fields);
        }

        return new PartInfo(
            reference,
            instance?.value ?? symbol.value ?? "",
            fields,
        );
    }

    /** For footprints without a symbol in the loaded schematic. */
    static from_footprint(footprint: Footprint): PartInfo {
        const fields: PartField[] = [];
        const add = (name: string, value: string | undefined) => {
            if (value !== undefined) {
                fields.push({ name, value });
            }
        };

        for (const [name, prop] of Object.entries(footprint.properties)) {
            add(name, prop.shown_text);
        }
        if (!fields.some((f) => f.name == "Reference")) {
            fields.unshift({ name: "Reference", value: footprint.reference });
        }
        PartInfo.#add_board_fields(footprint, add, fields);

        return new PartInfo(footprint.reference, footprint.value ?? "", fields);
    }

    static #add_board_fields(
        footprint: Footprint,
        add: (name: string, value: string | undefined) => void,
        fields: PartField[],
    ) {
        // Only when it differs from the symbol's Footprint field.
        if (
            !fields.some(
                (f) =>
                    f.name == "Footprint" && f.value == footprint.library_link,
            )
        ) {
            add("Board footprint", footprint.library_link);
        }
        add("Board side", footprint.layer?.startsWith("B.") ? "Bottom" : "Top");
        const at = footprint.at;
        if (at) {
            add(
                "Board position",
                `${at.position.x.toFixed(3)}, ${at.position.y.toFixed(3)} mm, ${at.rotation}°`,
            );
        }
    }
}

/**
 * Turns a datasheet field into a link target, or undefined if it's empty
 * ("~" is KiCad's placeholder for "no datasheet").
 */
export function datasheet_href(value: string | undefined): string | undefined {
    const v = value?.trim();
    if (!v || v == "~") {
        return undefined;
    }
    if (/^(https?|ftp|file):\/\//i.test(v)) {
        return v;
    }
    if (/^www\./i.test(v)) {
        return `https://${v}`;
    }
    return undefined;
}
