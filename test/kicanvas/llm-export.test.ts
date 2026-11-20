/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { crc32, zip } from "../../src/base/zip";
import { llm_export_texts } from "../../src/kicanvas/llm-export";
import { Project } from "../../src/kicanvas/project";
import { LocalFileSystem } from "../../src/kicanvas/services/vfs";

const ROOT = "aaaaaaaa-0000-0000-0000-000000000001";

const lib = `
    (symbol "Device:R" (pin_numbers hide) (in_bom yes) (on_board yes)
        (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
        (symbol "R_1_1"
            (pin passive line (at 0 3.81 270) (length 1.27)
                (name "~" (effects (font (size 1.27 1.27))))
                (number "1" (effects (font (size 1.27 1.27)))))
            (pin passive line (at 0 -3.81 90) (length 1.27)
                (name "~" (effects (font (size 1.27 1.27))))
                (number "2" (effects (font (size 1.27 1.27)))))))`;

function resistor(n: number, x: number) {
    const uuid = `bbbbbbbb-0000-0000-0000-00000000000${n}`;
    return `
    (symbol (lib_id "Device:R") (at ${x} 100 0) (unit 1)
        (in_bom yes) (on_board yes) (uuid "${uuid}")
        (property "Reference" "R${n}" (at ${x + 2} 100 0)
            (effects (font (size 1.27 1.27))))
        (property "Value" "10k" (at ${x + 2} 102 0)
            (effects (font (size 1.27 1.27))))
        (property "part_value" "RC0402FR-0710KL" (at ${x} 100 0)
            (effects (font (size 1.27 1.27)) hide))
        (pin "1" (uuid "${uuid.slice(0, -1)}a"))
        (pin "2" (uuid "${uuid.slice(0, -1)}b"))
        (instances (project "demo"
            (path "/${ROOT}" (reference "R${n}") (unit 1)))))`;
}

const sch = `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "${ROOT}")
    (paper "A4")
    (lib_symbols ${lib})
    ${resistor(1, 100)}
    ${resistor(2, 110)}
    (wire (pts (xy 100 103.81) (xy 110 103.81))
        (stroke (width 0) (type default)) (uuid "w1"))
    (label "MID" (at 105 103.81 0)
        (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))
    (sheet_instances (path "/" (page "1"))))`;

suite("export for an LLM", function () {
    test("the design as text", async function () {
        const fs = new LocalFileSystem([new File([sch], "demo.kicad_sch")]);
        await fs.setup();
        const project = new Project();
        await project.load(fs);

        const files = llm_export_texts(project, "abc1234", [
            { name: "images/sheet-01-Root.png", caption: "the root sheet" },
        ]);
        assert.deepEqual(
            files.map((f) => f.name),
            ["README.md", "design.md", "parts.csv", "nets.csv", "netlist.json"],
        );
        const md = files.find((f) => f.name == "design.md")!.text;
        assert.include(md, "Revision: abc1234");
        assert.include(md, "| R1 | 10k | RC0402FR-0710KL |");
        assert.include(md, "- **/MID** (2 pins; sheets /): R1.2, R2.2");
        assert.include(md, "`images/sheet-01-Root.png`: the root sheet");

        const json = JSON.parse(
            files.find((f) => f.name == "netlist.json")!.text,
        );
        assert.equal(json.parts.length, 2);
        assert.equal(json.parts[0].pins["2"].net, "/MID");
        assert.equal(json.parts[0].pins["1"].type, "passive");
    });

    test("ZIP archives", async function () {
        // The CRC-32 check value.
        assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);

        const blob = await zip([
            { name: "a/hello.txt", data: "hello ".repeat(100) },
            { name: "a/b.png", data: new Uint8Array([1, 2, 3]) },
        ]);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const view = new DataView(bytes.buffer);
        assert.equal(view.getUint32(0, true), 0x04034b50);
        // The end of central directory lists both files.
        const end = bytes.length - 22;
        assert.equal(view.getUint32(end, true), 0x06054b50);
        assert.equal(view.getUint16(end + 10, true), 2);
        // Text is deflated (where the browser can), PNGs are stored.
        const method = view.getUint16(8, true);
        assert.include([0, 8], method);
        assert.isBelow(bytes.length, 600 + 200);
    });
});
