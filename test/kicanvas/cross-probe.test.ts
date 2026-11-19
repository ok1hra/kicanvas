/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { Vec2 } from "../../src/base/math";
import { KicadPCB, KicadSch } from "../../src/kicad";
import {
    CrossProbeIndex,
    footprint_path,
} from "../../src/kicanvas/cross-probe";
import { Project } from "../../src/kicanvas/project";
import { LocalFileSystem } from "../../src/kicanvas/services/vfs";
import { SheetConnectivity } from "../../src/viewers/schematic/connectivity";

const ROOT = "aaaaaaaa-0000-0000-0000-000000000001";
const R1 = "bbbbbbbb-0000-0000-0000-000000000001";
const R2 = "bbbbbbbb-0000-0000-0000-000000000002";

const resistor_lib = `
    (symbol "Device:R" (pin_numbers hide) (in_bom yes) (on_board yes)
        (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
        (symbol "R_0_1"
            (rectangle (start -1 -2.5) (end 1 2.5)
                (stroke (width 0.25) (type default)) (fill (type none))))
        (symbol "R_1_1"
            (pin passive line (at 0 3.81 270) (length 1.27)
                (name "~" (effects (font (size 1.27 1.27))))
                (number "1" (effects (font (size 1.27 1.27)))))
            (pin passive line (at 0 -3.81 90) (length 1.27)
                (name "~" (effects (font (size 1.27 1.27))))
                (number "2" (effects (font (size 1.27 1.27)))))))`;

function resistor(uuid: string, ref: string, x: number) {
    return `
    (symbol (lib_id "Device:R") (at ${x} 100 0) (unit 1)
        (in_bom yes) (on_board yes) (uuid "${uuid}")
        (property "Reference" "${ref}" (at ${x + 2} 100 0)
            (effects (font (size 1.27 1.27))))
        (property "Value" "10k" (at ${x + 2} 102 0)
            (effects (font (size 1.27 1.27))))
        (pin "1" (uuid "${uuid.slice(0, -1)}a"))
        (pin "2" (uuid "${uuid.slice(0, -1)}b"))
        (instances (project "demo"
            (path "/${ROOT}" (reference "${ref}") (unit 1)))))`;
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

// R1 and R2 at x=100 and x=110. Pin 1 is at y=96.19, pin 2 at y=103.81.
// - R1.2 and R2.2 are wired together.
// - R1.1 and R2.1 each go to a "VIN" label, so they're connected by name.
const sch_src = `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "${ROOT}")
    (paper "A4")
    (lib_symbols ${resistor_lib})
    ${resistor(R1, "R1", 100)}
    ${resistor(R2, "R2", 110)}
    ${wire(100, 103.81, 110, 103.81)}
    ${wire(100, 96.19, 100, 90)}
    ${wire(110, 96.19, 110, 90)}
    ${label("VIN", 100, 90)}
    ${label("VIN", 110, 90)}
    (sheet_instances (path "/" (page "1"))))`;

function footprint(uuid: string, ref: string, nets: [string, string]) {
    return `
    (footprint "R_0402" (layer "F.Cu") (uuid "f${uuid.slice(1)}") (at 100 100)
        (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS")
            (effects (font (size 1 1))))
        (path "/${uuid}")
        (pad "1" smd rect (at -0.5 0) (size 0.5 0.5) (layers "F.Cu")
            (net "${nets[0]}"))
        (pad "2" smd rect (at 0.5 0) (size 0.5 0.5) (layers "F.Cu")
            (net "${nets[1]}")))`;
}

// KiCad 10 style: nets by name, no net table.
const pcb_src = `
(kicad_pcb (version 20260206) (generator "pcbnew")
    (general (thickness 1.6))
    (paper "A4")
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
    ${footprint(R1, "R1", ["VIN", "/MID"])}
    ${footprint(R2, "R2", ["VIN", "/MID"])}
    (segment (start 99.5 100) (end 100.5 100) (width 0.2) (layer "F.Cu")
        (net "/MID") (uuid "s1"))
)`;

async function load() {
    const fs = new LocalFileSystem([
        new File([pcb_src], "demo.kicad_pcb"),
        new File([sch_src], "demo.kicad_sch"),
    ]);
    await fs.setup();
    const project = new Project();
    await project.load(fs);
    const page = project.root_schematic_page!;
    const sch = page.document as KicadSch;
    const board = project.file_by_name("demo.kicad_pcb") as KicadPCB;
    return { project, page, sch, board };
}

suite("cross-probing: KiCad 10 board nets", function () {
    test("nets referenced by name get numbers", async function () {
        const { board } = await load();
        const mid = board.net_by_name("/MID")!;
        assert.exists(mid);
        assert.isNumber(mid.number);
        assert.notEqual(mid.number, 0);
        assert.equal(board.segments[0]!.net, mid.number);
        assert.equal(
            board.find_footprint("R2")!.pad_by_number("2")!.net.number,
            mid.number,
        );
        assert.equal(board.get_netname_by_number(mid.number), "/MID");
    });
});

suite("cross-probing: sheet connectivity", function () {
    test("wired pins and same-name labels connect", async function () {
        const { sch } = await load();
        const conn = SheetConnectivity.for(sch);
        const r1 = sch.find_symbol("R1")!;
        const r2 = sch.find_symbol("R2")!;

        const mid = conn.net_for_pin(r1, "2");
        assert.exists(mid);
        assert.strictEqual(conn.net_for_pin(r2, "2"), mid);

        const vin = conn.net_for_pin(r1, "1");
        assert.exists(vin);
        assert.strictEqual(conn.net_for_pin(r2, "1"), vin);
        assert.notStrictEqual(vin, mid);
        assert.equal(vin!.labels.length, 2);
    });

    test("clicking near a wire finds its net", async function () {
        const { sch } = await load();
        const conn = SheetConnectivity.for(sch);
        const mid = conn.net_for_pin(sch.find_symbol("R1")!, "2");

        assert.strictEqual(conn.net_at(new Vec2(105, 103.9), 0.25), mid);
        assert.isUndefined(conn.net_at(new Vec2(105, 110), 0.25));
    });
});

suite("cross-probing: index", function () {
    test("symbols and footprints map both ways", async function () {
        const { project, page, sch, board } = await load();
        const index = new CrossProbeIndex(project, board);
        const r2 = sch.find_symbol("R2")!;

        assert.equal(footprint_path(page, r2), `/${R2}`);
        assert.equal(index.footprint_for(page, r2)?.reference, "R2");

        const placements = index.symbols_for(board.find_footprint("R2")!);
        assert.equal(placements.length, 1);
        assert.strictEqual(placements[0]!.symbol, r2);
        assert.strictEqual(placements[0]!.page, page);
    });

    test("sheet nets are named after board nets", async function () {
        const { project, page, sch, board } = await load();
        const index = new CrossProbeIndex(project, board);
        const conn = SheetConnectivity.for(sch);

        const mid = conn.net_for_pin(sch.find_symbol("R1")!, "2")!;
        assert.equal(index.board_net_for(page, mid), "/MID");

        const vin_nets = index.sheet_nets_for(page, "VIN");
        assert.equal(vin_nets.length, 1);
        assert.strictEqual(
            vin_nets[0],
            conn.net_for_pin(sch.find_symbol("R2")!, "1"),
        );

        assert.deepEqual(
            index.pages_with_net("/MID").map((p) => p.project_path),
            [page.project_path],
        );
    });
});
