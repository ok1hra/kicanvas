/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { compare_projects } from "../../src/kicanvas/compare/diff";
import {
    bom_csv,
    changes_csv,
    markdown_report,
} from "../../src/kicanvas/compare/report";
import { Project } from "../../src/kicanvas/project";
import { LocalFileSystem } from "../../src/kicanvas/services/vfs";

const ROOT = "aaaaaaaa-0000-0000-0000-000000000001";
const uuid = (n: number) => `bbbbbbbb-0000-0000-0000-00000000000${n}`;

const resistor_lib = `
    (symbol "Device:R" (pin_numbers hide) (in_bom yes) (on_board yes)
        (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
        (symbol "R_1_1"
            (pin passive line (at 0 3.81 270) (length 1.27)
                (name "~" (effects (font (size 1.27 1.27))))
                (number "1" (effects (font (size 1.27 1.27)))))
            (pin passive line (at 0 -3.81 90) (length 1.27)
                (name "~" (effects (font (size 1.27 1.27))))
                (number "2" (effects (font (size 1.27 1.27)))))))`;

type Part = { n: number; ref: string; x: number; value: string; id: string };

function symbol(p: Part) {
    return `
    (symbol (lib_id "Device:R") (at ${p.x} 100 0) (unit 1)
        (in_bom yes) (on_board yes) (uuid "${uuid(p.n)}")
        (property "Reference" "${p.ref}" (at ${p.x + 2} 100 0)
            (effects (font (size 1.27 1.27))))
        (property "Value" "${p.value}" (at ${p.x + 2} 102 0)
            (effects (font (size 1.27 1.27))))
        (property "Footprint" "R_0402" (at ${p.x} 100 0)
            (effects (font (size 1.27 1.27)) hide))
        (property "ID" "${p.id}" (at ${p.x} 100 0)
            (effects (font (size 1.27 1.27)) hide))
        (pin "1" (uuid "${uuid(p.n).slice(0, -2)}a${p.n}"))
        (pin "2" (uuid "${uuid(p.n).slice(0, -2)}b${p.n}"))
        (instances (project "demo"
            (path "/${ROOT}" (reference "${p.ref}") (unit 1)))))`;
}

function wire(x1: number, y1: number, x2: number, y2: number) {
    return `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2}))
        (stroke (width 0) (type default)) (uuid "w-${x1}-${y1}-${x2}-${y2}"))`;
}

function label(text: string, x: number, y: number) {
    return `(label "${text}" (at ${x} ${y} 0)
        (effects (font (size 1.27 1.27)) (justify left bottom))
        (uuid "l-${text}-${x}"))`;
}

// Pin 1 of a resistor at x is at (x, 96.19), pin 2 at (x, 103.81).
function schematic(parts: Part[], wires: string[]) {
    return `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "${ROOT}")
    (paper "A4")
    (lib_symbols ${resistor_lib})
    ${parts.map(symbol).join("\n")}
    ${wires.join("\n")}
    (sheet_instances (path "/" (page "1"))))`;
}

function footprint(p: Part, nets: [string, string], at: string) {
    return `
    (footprint "R_0402" (layer "F.Cu") (uuid "f${uuid(p.n).slice(1)}") (at ${at})
        (property "Reference" "${p.ref}" (at 0 0 0) (layer "F.SilkS")
            (effects (font (size 1 1))))
        (path "/${uuid(p.n)}")
        (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu")
            (net "${nets[0]}"))
        (pad "2" smd rect (at 0.5 0) (size 0.5 0.5) (layers "F.Cu")
            (net "${nets[1]}")))`;
}

function board(items: string[]) {
    return `
(kicad_pcb (version 20260206) (generator "pcbnew")
    (general (thickness 1.6))
    (paper "A4")
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    ${items.join("\n")}
)`;
}

async function project(sch: string, pcb: string) {
    const fs = new LocalFileSystem([
        new File([pcb], "demo.kicad_pcb"),
        new File([sch], "demo.kicad_sch"),
    ]);
    await fs.setup();
    const p = new Project();
    await p.load(fs);
    return p;
}

const R1: Part = { n: 1, ref: "R1", x: 100, value: "10k", id: "6143" };
const R2: Part = { n: 2, ref: "R2", x: 110, value: "10k", id: "6143" };
const R3: Part = { n: 3, ref: "R3", x: 120, value: "1k", id: "6100" };

// A: R1 and R2, pin 2s wired together (/MID), pin 1s on "VIN" labels.
const sch_a = schematic(
    [R1, R2],
    [
        wire(100, 103.81, 110, 103.81),
        wire(100, 96.19, 100, 90),
        wire(110, 96.19, 110, 90),
        label("VIN", 100, 90),
        label("VIN", 110, 90),
    ],
);
const pcb_a = board([
    footprint(R1, ["VIN", "/MID"], "100 100"),
    footprint(R2, ["VIN", "/MID"], "105 100"),
    `(segment (start 100.5 100) (end 104.5 100) (width 0.2) (layer "F.Cu")
        (net "/MID") (uuid "s1"))`,
]);

suite("compare: revisions", function () {
    test("parts, fields, nets and layout", async function () {
        // B: R2 is 4k7 with another ID, R3 is new, R2's pin 2 goes to a
        // new "OUT" label instead of R1's (so /MID is gone), R1 moved and
        // the track was rerouted.
        const r2 = { ...R2, value: "4k7", id: "6150" };
        const sch_b = schematic(
            [R1, r2, R3],
            [
                wire(100, 96.19, 100, 90),
                wire(110, 96.19, 110, 90),
                label("VIN", 100, 90),
                label("VIN", 110, 90),
                wire(110, 103.81, 120, 103.81),
                label("OUT", 120, 103.81),
            ],
        );
        const pcb_b = board([
            footprint(R1, ["VIN", ""], "101 100"),
            footprint(r2, ["VIN", "/OUT"], "105 100"),
            footprint(R3, ["/OUT", ""], "110 100"),
            `(segment (start 105.5 100) (end 109.5 100) (width 0.2)
                (layer "F.Cu") (net "/OUT") (uuid "s2"))`,
        ]);

        const a = await project(sch_a, pcb_a);
        const b = await project(sch_b, pcb_b);
        const result = compare_projects(a, b);
        const titles = (category: string) =>
            result.changes
                .filter((c) => c.category == category)
                .map((c) => c.title);

        assert.sameMembers(titles("components"), ["R2 changed", "R3 added"]);
        const r2_change = result.changes.find((c) => c.title == "R2 changed")!;
        assert.includeMembers(r2_change.details, [
            "Value: 10k → 4k7",
            "ID: 6143 → 6150",
        ]);
        assert.deepEqual(r2_change.sch_b, [
            { sheet_path: `/${ROOT}`, symbol: uuid(2) },
        ]);

        // Nets are followed by their pins: R2.2 kept its net, which is now
        // named after the OUT label, and R1.2 isn't connected anymore.
        // (R3.2 joined it, but R3 is new, so that's part of adding R3.)
        const nets = result.changes.filter((c) => c.category == "nets");
        assert.deepEqual(
            nets.map((c) => [c.title, c.details]),
            [
                [
                    "Net /MID renamed",
                    ["Renamed: /MID → /OUT", "Disconnected: R1.2"],
                ],
            ],
        );

        assert.sameMembers(titles("layout"), [
            "Footprint R1 changed",
            "Footprint R3 added",
            "Routing of /MID",
            "Routing of /OUT",
        ]);
        const r1 = result.changes.find(
            (c) => c.title == "Footprint R1 changed",
        )!;
        assert.deepEqual(r1.details, ["Moved by 1.000, 0.000 mm"]);
        assert.isUndefined(result.shift);

        // The BOM: R2 left the 10k group and formed a new one; R3 is new.
        assert.deepEqual(
            result.bom.map((r) => [
                r.status,
                r.value,
                r.refs_a.join(" "),
                r.refs_b.join(" "),
            ]),
            [
                ["changed", "10k", "R1 R2", "R1"],
                ["added", "4k7", "", "R2"],
                ["added", "1k", "", "R3"],
            ],
        );

        // Reports.
        const shown = new Set(["components", "nets", "layout"] as const);
        const md = markdown_report(
            "demo",
            { id: "a", label: "a" },
            { id: "b", label: "b" },
            result,
            new Set(shown),
        );
        assert.include(md, "# Changes in demo: a → b");
        assert.include(md, "- **R2 changed**");
        assert.include(md, "  - Value: 10k → 4k7");
        const csv = changes_csv(result, new Set(shown));
        assert.isTrue(csv.startsWith("﻿Category;Kind;Change"));
        assert.include(bom_csv(result), "changed;2;1;10k");
    });

    test("a renamed net and a moved layout", async function () {
        // B: the VIN labels are now "PWR"; the whole board moved by 10, 5.
        const sch_b = sch_a.replace(/"VIN"/g, '"PWR"');
        const pcb_b = board([
            footprint(R1, ["PWR", "/MID"], "110 105"),
            footprint(R2, ["PWR", "/MID"], "115 105"),
            `(segment (start 110.5 105) (end 114.5 105) (width 0.2)
                (layer "F.Cu") (net "/MID") (uuid "s1"))`,
        ]);
        const a = await project(sch_a, pcb_a);
        const b = await project(sch_b, pcb_b);
        const result = compare_projects(a, b);

        const nets = result.changes.filter((c) => c.category == "nets");
        assert.deepEqual(
            nets.map((c) => [c.title, c.details]),
            [["Net VIN renamed", ["Renamed: VIN → PWR"]]],
        );

        // Too few footprints to call it a layout move: they just moved.
        assert.isUndefined(result.shift);
        assert.equal(
            result.changes.filter((c) => c.title.startsWith("Footprint"))
                .length,
            2,
        );
    });

    test("a layout moved as a whole isn't a change of every item", async function () {
        const parts = [1, 2, 3, 4, 5, 6].map((n) => ({
            n,
            ref: `R${n}`,
            x: 100 + n * 10,
            value: "10k",
            id: "6143",
        }));
        const sch = schematic(parts, []);
        const layout = (dx: number, dy: number) =>
            board([
                ...parts.map((p) =>
                    footprint(p, ["", ""], `${p.x + dx} ${100 + dy}`),
                ),
                `(segment (start ${100 + dx} ${110 + dy}) (end ${120 + dx} ${110 + dy})
                    (width 0.2) (layer "F.Cu") (net "") (uuid "s1"))`,
            ]);
        const a = await project(sch, layout(0, 0));
        // R6 also moved on its own.
        const b = await project(
            sch,
            layout(10, 5).replace(/\(at 170 105\)/, "(at 171 105)"),
        );
        const result = compare_projects(a, b);

        assert.closeTo(result.shift!.dx, 10, 1e-9);
        assert.closeTo(result.shift!.dy, 5, 1e-9);
        assert.deepEqual(
            result.changes.map((c) => [c.title, c.details]),
            [
                [
                    "Layout moved",
                    [
                        "By 10.000, 5.000 mm (5 of 6 footprints); A is aligned to B",
                    ],
                ],
                ["Footprint R6 changed", ["Moved by 1.000, 0.000 mm"]],
            ],
        );
    });
});
