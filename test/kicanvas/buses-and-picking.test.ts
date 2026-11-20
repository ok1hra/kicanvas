/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { BBox, Vec2 } from "../../src/base/math";
import { KicadPCB, KicadSch } from "../../src/kicad";
import { instance_for } from "../../src/kicad/schematic";
import { CrossProbeIndex } from "../../src/kicanvas/cross-probe";
import { PartInfo } from "../../src/kicanvas/part-info";
import { Project } from "../../src/kicanvas/project";
import { decode_view, encode_view } from "../../src/kicanvas/share";
import { LocalFileSystem } from "../../src/kicanvas/services/vfs";
import { pick_board } from "../../src/viewers/board/picking";
import {
    SheetConnectivity,
    bus_members,
    is_bus_name,
} from "../../src/viewers/schematic/connectivity";

const ROOT = "aaaaaaaa-0000-0000-0000-000000000001";
const SHEET = "cccccccc-0000-0000-0000-000000000001";
const R1 = "bbbbbbbb-0000-0000-0000-000000000001";

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

const effects = `(effects (font (size 1.27 1.27)) (justify left bottom))`;

function wire(x1: number, y1: number, x2: number, y2: number) {
    return `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2}))
        (stroke (width 0) (type default)) (uuid "w-${x1}-${y1}-${x2}-${y2}"))`;
}

suite("buses: member names", function () {
    test("vectors, groups and aliases", function () {
        const aliases = new Map([
            ["I2C", ["SDA", "SCL"]],
            ["LCD", ["CLK", "D[0..1]"]],
        ]);
        assert.deepEqual(bus_members("D[0..2]"), ["D0", "D1", "D2"]);
        assert.deepEqual(bus_members("A[2..1]"), ["A2", "A1"]);
        assert.deepEqual(bus_members("USB{DP DM}"), ["USB.DP", "USB.DM"]);
        assert.deepEqual(bus_members("{SDA SCL}"), ["SDA", "SCL"]);
        assert.deepEqual(bus_members("I2C", aliases), ["SDA", "SCL"]);
        assert.deepEqual(bus_members("LCD{LCD}", aliases), [
            "LCD.CLK",
            "LCD.D0",
            "LCD.D1",
        ]);
        assert.deepEqual(bus_members("X{~{CS} D[0..1]}"), [
            "X.~{CS}",
            "X.D0",
            "X.D1",
        ]);
    });

    test("overbars aren't buses", function () {
        assert.isFalse(is_bus_name("~{RESET}"));
        assert.isFalse(is_bus_name("SDA"));
        assert.isTrue(is_bus_name("D[0..7]"));
        assert.isTrue(is_bus_name("I2C{SDA SCL}"));
    });
});

suite("buses: sheet connectivity", function () {
    // A bus from (100,50) to (130,50) labeled D[0..1], with entries down to
    // wires labeled D0 and D1.
    const src = `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "${ROOT}")
    (paper "A4")
    (lib_symbols)
    (bus (pts (xy 100 50) (xy 130 50))
        (stroke (width 0) (type default)) (uuid "bus-1"))
    (bus_entry (at 110 50) (size 2.54 2.54)
        (stroke (width 0) (type default)) (uuid "be-1"))
    (bus_entry (at 120 50) (size 2.54 2.54)
        (stroke (width 0) (type default)) (uuid "be-2"))
    ${wire(112.54, 52.54, 112.54, 60)}
    ${wire(122.54, 52.54, 122.54, 60)}
    (label "D[0..1]" (at 102 50 0) ${effects} (uuid "l-bus"))
    (label "D0" (at 112.54 60 0) ${effects} (uuid "l-d0"))
    (label "D1" (at 122.54 60 0) ${effects} (uuid "l-d1"))
    (sheet_instances (path "/" (page "1"))))`;

    test("buses are found and aren't nets", function () {
        const sch = new KicadSch("bus.kicad_sch", src);
        const conn = SheetConnectivity.for(sch);

        assert.equal(conn.buses.length, 1);
        const bus = conn.buses[0]!;
        assert.deepEqual(bus.names, ["D[0..1]"]);
        assert.deepEqual(bus.members(), ["D0", "D1"]);
        assert.equal(bus.entries.length, 2);

        // The bus label isn't a net, the member labels are.
        const labels = conn.nets.flatMap((n) => n.labels.map((l) => l.text));
        assert.sameMembers(labels, ["D0", "D1"]);

        assert.strictEqual(conn.item_at(new Vec2(125, 50.1), 0.25).bus, bus);
        const d0 = conn.item_at(new Vec2(112.6, 55), 0.25).net;
        assert.equal(d0?.labels[0]?.text, "D0");
    });
});

// Root: R1 pin 1 wired to the "SIG" pin of a sheet. The sheet: a
// hierarchical label "SIG" on a wire with no pins.
const root_src = `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "${ROOT}")
    (paper "A4")
    (lib_symbols ${resistor_lib})
    (symbol (lib_id "Device:R") (at 100 100 0) (unit 1)
        (in_bom yes) (on_board yes) (uuid "${R1}")
        (property "Reference" "R1" (at 102 100 0)
            (effects (font (size 1.27 1.27))))
        (property "Value" "10k" (at 102 102 0)
            (effects (font (size 1.27 1.27))))
        (pin "1" (uuid "${R1.slice(0, -1)}a"))
        (pin "2" (uuid "${R1.slice(0, -1)}b"))
        (instances (project "demo"
            (path "/${ROOT}" (reference "R1") (unit 1)))))
    ${wire(100, 96.19, 100, 80)}
    ${wire(100, 80, 140, 80)}
    (sheet (at 140 70) (size 20 20)
        (stroke (width 0) (type solid)) (fill (color 0 0 0 0))
        (uuid "${SHEET}")
        (property "Sheetname" "Child" (at 140 69 0)
            (effects (font (size 1.27 1.27)) (justify left bottom)))
        (property "Sheetfile" "child.kicad_sch" (at 140 91 0)
            (effects (font (size 1.27 1.27)) (justify left top)))
        (pin "SIG" input (at 140 80 180)
            (effects (font (size 1.27 1.27)) (justify left))
            (uuid "dddddddd-0000-0000-0000-000000000001"))
        (instances (project "demo" (path "/${ROOT}" (page "2")))))
    (sheet_instances (path "/" (page "1"))))`;

const child_src = `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "eeeeeeee-0000-0000-0000-000000000001")
    (paper "A4")
    (lib_symbols)
    ${wire(50, 50, 80, 50)}
    (hierarchical_label "SIG" (shape input) (at 50 50 180)
        (effects (font (size 1.27 1.27)) (justify right))
        (uuid "ffffffff-0000-0000-0000-000000000001")))`;

function footprint(
    uuid: string,
    ref: string,
    nets: [string, string],
    at = "100 100",
) {
    return `
    (footprint "R_0402" (layer "F.Cu") (uuid "f${uuid.slice(1)}") (at ${at})
        (property "Reference" "${ref}" (at 0 0 0) (layer "F.SilkS")
            (effects (font (size 1 1))))
        (path "/${uuid}")
        (fp_rect (start -2 -1) (end 2 1) (layer "F.CrtYd")
            (stroke (width 0.05) (type default)) (fill none))
        (pad "1" smd rect (at -1 0) (size 0.6 0.6) (layers "F.Cu")
            (net "${nets[0]}"))
        (pad "2" smd rect (at 1 0) (size 0.6 0.6) (layers "F.Cu")
            (net "${nets[1]}")))`;
}

const pcb_src = `
(kicad_pcb (version 20260206) (generator "pcbnew")
    (general (thickness 1.6))
    (paper "A4")
    (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user)
        (46 "B.CrtYd" user) (47 "F.CrtYd" user))
    ${footprint(R1, "R1", ["/SIG", "GND"])}
    (segment (start 90 105) (end 110 105) (width 0.25) (layer "F.Cu")
        (net "/SIG") (uuid "s1"))
)`;

async function load_hierarchy() {
    const fs = new LocalFileSystem([
        new File([pcb_src], "demo.kicad_pcb"),
        new File([root_src], "demo.kicad_sch"),
        new File([child_src], "child.kicad_sch"),
    ]);
    await fs.setup();
    const project = new Project();
    await project.load(fs);
    const board = project.file_by_name("demo.kicad_pcb") as KicadPCB;
    return { project, board };
}

suite("cross-probing: nets across sheets", function () {
    test("a sheet pin connects to the hierarchical label", async function () {
        const { project, board } = await load_hierarchy();
        const index = new CrossProbeIndex(project, board);
        const root = project.root_schematic_page!;
        const child = project.page_by_sheet_path(`/${ROOT}/${SHEET}`)!;
        assert.exists(child);

        // The child's net has no pins, but is the root's /SIG net.
        const child_net = SheetConnectivity.for(
            child.document as KicadSch,
        ).nets.find((n) => n.labels.some((l) => l.text == "SIG"))!;
        assert.equal(index.net_key(child, child_net), "/SIG");

        assert.sameMembers(
            index.pages_with_net("/SIG").map((p) => p.project_path),
            [root.project_path, child.project_path],
        );
    });
});

suite("board picking", function () {
    const opts = {
        tolerance: 0.05,
        flipped: false,
        is_visible: () => true,
        zone_fills: false,
    };

    test("inside the courtyard picks the footprint", async function () {
        const { board } = await load_hierarchy();
        const hits = pick_board(board, new Vec2(100, 100.8), opts);
        assert.equal(hits.length, 1);
        assert.equal(hits[0]!.kind, "footprint");
    });

    test("a pad picks its footprint and net", async function () {
        const { board } = await load_hierarchy();
        const hits = pick_board(board, new Vec2(99, 100.1), opts);
        assert.deepEqual(
            hits.map((h) => (h.kind == "net" ? `${h.name} ${h.what}` : h.kind)),
            ["footprint", "/SIG pad 1"],
        );
    });

    test("tracks pick their net, empty space nothing", async function () {
        const { board } = await load_hierarchy();
        const hits = pick_board(board, new Vec2(92, 105.1), opts);
        assert.deepEqual(
            hits.map((h) => (h.kind == "net" ? `${h.name} ${h.what}` : h.kind)),
            ["/SIG track"],
        );
        assert.isEmpty(pick_board(board, new Vec2(92, 110), opts));
    });

    test("hidden layers can't be picked", async function () {
        const { board } = await load_hierarchy();
        const hits = pick_board(board, new Vec2(92, 105.1), {
            ...opts,
            is_visible: (l: string) => l != "F.Cu",
        });
        assert.isEmpty(hits);
    });
});

suite("part info rows", function () {
    test("fields with the same value are listed once", function () {
        const info = new PartInfo("U1", "MCU", [
            { name: "Reference", value: "U1" },
            { name: "Value", value: "MCU" },
            { name: "part_value", value: "MIMXRT" },
            { name: "Description", value: "ARM MCU" },
            { name: "req", value: "ARM MCU" },
            { name: "Note", value: "~" },
            { name: "Other", value: "~" },
            { name: "On stock", value: "0" },
            { name: "On order", value: "0" },
        ]);
        const rows = info.rows().map((r) => [r.names.join(" / "), r.key]);
        assert.deepEqual(rows, [
            ["ID", true],
            ["Datasheet", true],
            ["part_value", true],
            ["Value", false],
            ["Description / req", false],
            ["Note", false],
            ["Other", false],
            ["On stock", false],
            ["On order", false],
        ]);
    });
});

suite("shared links", function () {
    test("view state survives the URL", function () {
        const state = {
            sheet: "mcu.kicad_sch:/a/b",
            sch: new BBox(10.5, -20.25, 100, 60.125),
            board: new BBox(0, 0, 50.5, 25),
            flip: true,
            nets: ["/MCU/LCD_DSI.CKP", "GND,odd name"],
        };
        const decoded = decode_view(`#${encode_view(state)}`)!;
        assert.equal(decoded.sheet, state.sheet);
        assert.deepEqual(
            [decoded.sch!.x, decoded.sch!.y, decoded.sch!.w, decoded.sch!.h],
            [10.5, -20.25, 100, 60.125],
        );
        assert.equal(decoded.board!.w, 50.5);
        assert.isTrue(decoded.flip);
        assert.deepEqual(decoded.nets, state.nets);
        assert.isUndefined(decoded.part);
    });

    test("links without a view", function () {
        assert.isNull(decode_view(""));
        assert.isNull(decode_view("#"));
        assert.isNull(decode_view("#s=1,2,nope,4"));
        assert.equal(decode_view("#part=U5")!.part, "U5");
    });

    test("the shown revision and compared revisions", function () {
        const sha = "ffb1c5d9c7cb9e62a650291edf46a19e0204f7c7";
        const state = decode_view(
            `#${encode_view({ rev: sha, part: "L23" })}`,
        )!;
        assert.equal(state.rev, sha);
        assert.equal(state.part, "L23");
        assert.isUndefined(decode_view("#rev=../etc")?.rev);

        const cmp = decode_view(
            `#${encode_view({ compare: { a: "abc1234", b: "WORKTREE", mode: "overlay" } })}`,
        )!;
        assert.deepEqual(cmp.compare, {
            a: "abc1234",
            b: "WORKTREE",
            mode: "overlay",
        });
    });
});

suite("sheet instances", function () {
    test("instance paths with another project's root UUID", function () {
        const instances = new Map([
            ["/old-root/sheet/a", "C1_1"],
            ["/old-root/sheet/b", "C1_2"],
            ["/root/other", "R9"],
        ]);
        assert.equal(instance_for(instances, "/root/other"), "R9");
        // The schematic was copied from a project with another root.
        assert.equal(instance_for(instances, "/root/sheet/b"), "C1_2");
        assert.equal(instance_for(instances, "/root/sheet/a"), "C1_1");
        assert.isUndefined(instance_for(instances, "/root/sheet/c"));
    });
});
