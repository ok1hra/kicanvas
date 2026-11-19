/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { Footprint } from "../kicad/board";
import type { SchematicSymbol } from "../kicad/schematic";
import { reference_in } from "./cross-probe";
import type { ProjectPage } from "./project";

export type PartField = { name: string; value: string };

/** Fields shown before "Show all", in this order. */
export const key_fields = ["ID", "Datasheet", "part_value"];

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
        const instance = symbol.instances.get(page.sheet_path);
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
            PartInfo.#add_board_fields(footprint, add);
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
        PartInfo.#add_board_fields(footprint, add);

        return new PartInfo(footprint.reference, footprint.value ?? "", fields);
    }

    static #add_board_fields(
        footprint: Footprint,
        add: (name: string, value: string | undefined) => void,
    ) {
        add("Board footprint", footprint.library_link);
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
