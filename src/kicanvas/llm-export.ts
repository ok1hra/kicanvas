/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Arc as MathArc } from "../base/math";
import type { KicadPCB } from "../kicad";
import { ArcSegment, LineSegment } from "../kicad/board";
import type { KicadSch } from "../kicad/schematic";
import { SheetConnectivity } from "../viewers/schematic/connectivity";
import {
    collect_parts,
    first_board,
    hierarchy_pages,
    netlist,
} from "./compare/diff";
import { csv } from "./compare/report";
import { reference_in } from "./cross-probe";
import type { Project, ProjectPage } from "./project";

/**
 * A summary of a whole design for an LLM (a chat assistant): the parts,
 * nets, sheets and board as compact text, since the KiCad files themselves
 * are far too big (and mostly graphics).
 */

/** An image that's part of the export, see llm-images.ts. */
export type ExportImage = { name: string; caption: string };

export type ExportText = { name: string; text: string };

const natural = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true });

const mm = (v: number) => (Math.round(v * 100) / 100).toString();

/** Markdown table cell */
const cell = (v: string | number | undefined) =>
    String(v ?? "")
        .replace(/\|/g, "\\|")
        .replace(/\s+/g, " ")
        .trim();

const MPN_FIELDS = [
    "part_value",
    "MPN",
    "Manufacturer_Part_Number",
    "Manufacturer Part Number",
];

function segment_length(s: LineSegment | ArcSegment) {
    if (s instanceof ArcSegment) {
        const pts = MathArc.from_three_points(
            s.start,
            s.mid,
            s.end,
        ).to_polyline();
        let length = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            length += pts[i + 1]!.sub(pts[i]!).magnitude;
        }
        return length;
    }
    return s.end.sub(s.start).magnitude;
}

function sheet_name(page: ProjectPage) {
    return page.sheet?.sheetname ?? page.name ?? page.filename;
}

/** A pin is meaningfully named if its name isn't just its number. */
function pin_label(pin: string, name: string | undefined) {
    const number = pin.slice(pin.lastIndexOf(".") + 1);
    const meaningful =
        name && name != "~" && name != number && !/^pin_?\d+$/i.test(name);
    return meaningful ? `${pin}(${name})` : pin;
}

export function llm_export_texts(
    project: Project,
    revision: string,
    images: ExportImage[],
): ExportText[] {
    const board = first_board(project);
    const pages = hierarchy_pages(project);
    const parts = collect_parts(project);
    const nl = netlist(project, board);
    const index = nl.index;
    const footprints = new Map(board?.footprints.map((f) => [f.reference, f]));
    const human = (p: ProjectPage) => project.human_sheet_path(p.sheet_path);

    // Pin names and types, by "REF.PIN".
    const pins = new Map<string, { name: string; type: string }>();
    for (const page of pages) {
        for (const symbol of (page.document as KicadSch).symbols.values()) {
            if (symbol.lib_symbol.power) {
                continue;
            }
            const ref = reference_in(page, symbol);
            for (const pin of symbol.unit_pins) {
                const def = pin.definition;
                if (def) {
                    pins.set(`${ref}.${pin.number}`, {
                        name: def.name.text,
                        type: def.type,
                    });
                }
            }
        }
    }

    // The sheets each net is on, and each pin's net.
    const net_sheets = new Map<string, Set<string>>();
    for (const page of pages) {
        const conn = SheetConnectivity.for(page.document as KicadSch);
        for (const net of conn.nets) {
            const group = index.groups.group(page, net);
            if (group === undefined) {
                continue;
            }
            const set = net_sheets.get(`${group}`) ?? new Set<string>();
            set.add(human(page));
            net_sheets.set(`${group}`, set);
        }
    }
    const nets = [...nl.nets.values()]
        .filter((n) => n.pins.size)
        .sort((a, b) => natural(a.name, b.name));
    const pin_net = new Map<string, string>();
    for (const net of nets) {
        for (const pin of net.pins) {
            pin_net.set(pin, net.name);
        }
    }
    const connected = nets.filter((n) => n.pins.size > 1);
    const unconnected = nets.filter((n) => n.pins.size == 1);

    const refs = [...parts.keys()].sort(natural);
    const mpn = (fields: Map<string, string>) =>
        MPN_FIELDS.map((f) => fields.get(f)).find((v) => v) ?? "";
    const part_sheets = (ref: string) => [
        ...new Set(parts.get(ref)!.placements.map((p) => human(p.page))),
    ];

    // Routing per net.
    type Routing = {
        length: number;
        widths: Set<number>;
        layers: Set<string>;
        vias: number;
    };
    const routing = new Map<string, Routing>();
    const route = (net: string) => {
        let r = routing.get(net);
        if (!r) {
            r = { length: 0, widths: new Set(), layers: new Set(), vias: 0 };
            routing.set(net, r);
        }
        return r;
    };
    if (board) {
        for (const s of board.segments) {
            const r = route(board.get_netname_by_number(s.net) ?? "");
            r.length += segment_length(s);
            r.widths.add(Math.round(s.width * 1000) / 1000);
            r.layers.add(s.layer);
        }
        for (const v of board.vias) {
            route(board.get_netname_by_number(v.net) ?? "").vias++;
        }
    }

    const copper = board
        ? board.layers
              .map((l) => l.canonical_name)
              .filter((n) => n.endsWith(".Cu"))
        : [];
    const outline = board?.edge_cuts_bbox;

    // design.md
    const md: string[] = [];
    const now = new Date().toISOString().slice(0, 16).replace("T", " ");
    md.push(
        `# ${project.name}: design summary`,
        "",
        `Revision: ${revision} · exported ${now} by KiCanvas from the KiCad files.`,
        "",
        "## How to read this",
        "",
        "- This summarizes a KiCad schematic and board for answering questions about the design. The images in `images/` show the sheets and the board.",
        "- Parts are named by reference (U5, R12). A pin is written `REF.PIN`, e.g. `U5.N12`, with the pin's name in parentheses where it has one: `U5.N12(GPIO_AD_23)`.",
        "- Net names come from the board, or from labels and power symbols like KiCad names them; `Net-(R1-Pad2)` style names are nets without a label.",
        "- Sheet paths are like KiCad's: `/` is the root sheet, `/Power/` a sheet named Power in it.",
        "- Board positions are in mm, in KiCad's coordinates (x to the right, y down). Rotation in degrees, counterclockwise.",
        "- The same data is in `parts.csv`, `nets.csv` and `netlist.json` for tools.",
        "",
        "## Overview",
        "",
        `- ${pages.length} schematic sheets, ${parts.size} parts, ${connected.length} nets (and ${unconnected.length} pins not connected to anything).`,
    );
    if (board) {
        md.push(
            `- Board: ${outline?.valid ? `${mm(outline.w)} × ${mm(outline.h)} mm, ` : ""}${copper.length} copper layers (${copper.join(", ")}), ${board.general?.thickness ?? "?"} mm thick; ${board.footprints.length} footprints (${board.footprints.filter((f) => f.layer?.startsWith("B.")).length} on the bottom), ${board.segments.length} track segments, ${board.vias.length} vias.`,
        );
    }
    md.push(
        "",
        "## Sheets",
        "",
        "| Page | Sheet | Path | File | Parts |",
        "|---|---|---|---|---|",
    );
    for (const page of pages) {
        const doc = page.document as KicadSch;
        const n = [...doc.symbols.values()].filter(
            (s) => !s.lib_symbol.power,
        ).length;
        md.push(
            `| ${cell(page.page ?? "")} | ${cell(sheet_name(page))} | ${cell(human(page))} | ${cell(page.filename)} | ${n} |`,
        );
    }

    md.push(
        "",
        "## Parts",
        "",
        "| Ref | Value | MPN | ID | Footprint | Description | Sheet | Notes |",
        "|---|---|---|---|---|---|---|---|",
    );
    for (const ref of refs) {
        const p = parts.get(ref)!;
        const notes = [
            p.dnp ? "DNP" : "",
            !p.in_bom ? "not in BOM" : "",
            !p.on_board ? "not on board" : "",
            board && !footprints.has(ref) && p.on_board
                ? "no footprint on the board"
                : "",
        ]
            .filter(Boolean)
            .join(", ");
        md.push(
            `| ${cell(ref)} | ${cell(p.value)} | ${cell(mpn(p.fields))} | ${cell(p.fields.get("ID"))} | ${cell(p.footprint)} | ${cell(p.fields.get("Description"))} | ${cell(part_sheets(ref).join(" "))} | ${cell(notes)} |`,
        );
    }

    md.push("", "## Nets", "");
    for (const net of connected) {
        const sheets = [...(net_sheets.get(net.id) ?? [])].sort(natural);
        const list = [...net.pins]
            .sort(natural)
            .map((pin) => pin_label(pin, pins.get(pin)?.name));
        md.push(
            `- **${net.name}** (${net.pins.size} pins; sheets ${sheets.join(" ")}): ${list.join(", ")}`,
        );
    }
    if (unconnected.length) {
        md.push(
            "",
            `Pins not connected to anything (${unconnected.length}): ${unconnected
                .flatMap((n) => [...n.pins])
                .sort(natural)
                .map((pin) => pin_label(pin, pins.get(pin)?.name))
                .join(", ")}`,
        );
    }

    if (board) {
        md.push(
            "",
            "## Board",
            "",
            "### Placement",
            "",
            "| Ref | Side | X | Y | Rot | Footprint |",
            "|---|---|---|---|---|---|",
        );
        for (const fp of [...board.footprints].sort((a, b) =>
            natural(a.reference ?? "", b.reference ?? ""),
        )) {
            md.push(
                `| ${cell(fp.reference)} | ${fp.layer?.startsWith("B.") ? "bottom" : "top"} | ${mm(fp.at.position.x)} | ${mm(fp.at.position.y)} | ${fp.at.rotation ?? 0} | ${cell(fp.library_link)} |`,
            );
        }
        md.push(
            "",
            "### Routing",
            "",
            "| Net | Track length (mm) | Track widths (mm) | Layers | Vias |",
            "|---|---|---|---|---|",
        );
        for (const [net, r] of [...routing].sort((a, b) =>
            natural(a[0], b[0]),
        )) {
            md.push(
                `| ${cell(net || "(no net)")} | ${mm(r.length)} | ${[...r.widths].sort((a, b) => a - b).join(", ")} | ${[...r.layers].sort().join(", ")} | ${r.vias} |`,
            );
        }
    }

    if (images.length) {
        md.push("", "## Images", "");
        for (const image of images) {
            md.push(`- \`${image.name}\`: ${image.caption}`);
        }
    }

    // parts.csv, nets.csv
    const parts_csv = csv([
        [
            "Reference",
            "Value",
            "MPN",
            "ID",
            "Footprint",
            "Description",
            "Datasheet",
            "DNP",
            "In BOM",
            "Sheets",
            "Board side",
            "X (mm)",
            "Y (mm)",
            "Rotation",
        ],
        ...refs.map((ref) => {
            const p = parts.get(ref)!;
            const fp = footprints.get(ref);
            return [
                ref,
                p.value,
                mpn(p.fields),
                p.fields.get("ID") ?? "",
                p.footprint,
                p.fields.get("Description") ?? "",
                p.fields.get("Datasheet") ?? "",
                p.dnp ? "yes" : "no",
                p.in_bom ? "yes" : "no",
                part_sheets(ref).join(" "),
                fp ? (fp.layer?.startsWith("B.") ? "bottom" : "top") : "",
                fp ? mm(fp.at.position.x) : "",
                fp ? mm(fp.at.position.y) : "",
                fp ? (fp.at.rotation ?? 0) : "",
            ];
        }),
    ]);
    const nets_csv = csv([
        ["Net", "Pins", "Pin count", "Sheets", "Track length (mm)", "Vias"],
        ...nets.map((n) => [
            n.name,
            [...n.pins]
                .sort(natural)
                .map((pin) => pin_label(pin, pins.get(pin)?.name))
                .join(" "),
            n.pins.size,
            [...(net_sheets.get(n.id) ?? [])].sort(natural).join(" "),
            routing.has(n.name) ? mm(routing.get(n.name)!.length) : "",
            routing.get(n.name)?.vias ?? "",
        ]),
    ]);

    // netlist.json
    const json = {
        format: "kicanvas-llm/v1",
        project: project.name,
        revision,
        units: "mm",
        sheets: pages.map((p) => ({
            page: p.page,
            name: sheet_name(p),
            path: human(p),
            file: p.filename,
        })),
        parts: refs.map((ref) => {
            const p = parts.get(ref)!;
            const fp = footprints.get(ref);
            const part_pins: Record<
                string,
                { name: string; type: string; net: string | null }
            > = {};
            for (const [pin, info] of pins) {
                if (pin.slice(0, pin.lastIndexOf(".")) == ref) {
                    part_pins[pin.slice(pin.lastIndexOf(".") + 1)] = {
                        ...info,
                        net: pin_net.get(pin) ?? null,
                    };
                }
            }
            return {
                ref,
                value: p.value,
                footprint: p.footprint,
                symbol: p.lib_id,
                dnp: p.dnp,
                in_bom: p.in_bom,
                fields: Object.fromEntries(p.fields),
                sheets: part_sheets(ref),
                board: fp
                    ? {
                          side: fp.layer?.startsWith("B.") ? "bottom" : "top",
                          x: fp.at.position.x,
                          y: fp.at.position.y,
                          rotation: fp.at.rotation ?? 0,
                          footprint: fp.library_link,
                      }
                    : null,
                pins: part_pins,
            };
        }),
        nets: nets.map((n) => ({
            name: n.name,
            pins: [...n.pins].sort(natural),
            sheets: [...(net_sheets.get(n.id) ?? [])].sort(natural),
            routing: routing.has(n.name)
                ? {
                      length:
                          Math.round(routing.get(n.name)!.length * 100) / 100,
                      widths: [...routing.get(n.name)!.widths],
                      layers: [...routing.get(n.name)!.layers],
                      vias: routing.get(n.name)!.vias,
                  }
                : null,
        })),
        board: board
            ? {
                  size: outline?.valid ? [outline.w, outline.h] : null,
                  thickness: board.general?.thickness ?? null,
                  copper_layers: copper,
              }
            : null,
        images,
    };

    const readme = [
        `# ${project.name} for an LLM`,
        "",
        `Revision: ${revision}. Exported by KiCanvas.`,
        "",
        "Give `design.md` to the LLM (and the images, if it can read images). The other files have the same data for tools and spreadsheets:",
        "",
        "- `design.md`: everything as text: sheets, parts, nets with their pins, board placement and routing",
        "- `parts.csv`: the parts (BOM data, sheets, board position)",
        "- `nets.csv`: the nets with their pins",
        "- `netlist.json`: all of it, structured, including each part's pins",
        "- `images/`: each schematic sheet and the board",
        "",
        "Some questions to start with: “Check the power supply of U5”, “Which parts are on the 3V3 net?”, “Is the USB data pair routed with the same width?”.",
        "",
    ].join("\n");

    return [
        { name: "README.md", text: readme },
        { name: "design.md", text: md.join("\n") + "\n" },
        { name: "parts.csv", text: parts_csv },
        { name: "nets.csv", text: nets_csv },
        { name: "netlist.json", text: JSON.stringify(json, null, 1) },
    ];
}

/** The board of a project, for images. */
export function export_board(project: Project): KicadPCB | undefined {
    return first_board(project);
}
