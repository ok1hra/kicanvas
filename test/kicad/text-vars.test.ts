/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { expand_text_vars } from "../../src/kicad/common";
import { KicadPCB, KicadSch } from "../../src/kicad";
import { Project } from "../../src/kicanvas/project";
import { LocalFileSystem } from "../../src/kicanvas/services/vfs";

import empty_pcb_src from "./files/empty.kicad_pcb";

const ROOT_UUID = "aaaaaaaa-0000-0000-0000-000000000001";
const ALPHA_UUID = "bbbbbbbb-0000-0000-0000-000000000001";
const BETA_UUID = "bbbbbbbb-0000-0000-0000-000000000002";

function sheet(uuid: string, name: string, variant: string, page: string) {
    return `
    (sheet (at 10 10) (size 20 10) (uuid "${uuid}")
        (property "Sheetname" "${name}" (at 10 9 0)
            (effects (font (size 1.27 1.27))))
        (property "Sheetfile" "child.kicad_sch" (at 10 21 0)
            (effects (font (size 1.27 1.27))))
        (property "Variant" "${variant}" (at 10 22 0)
            (effects (font (size 1.27 1.27)) hide))
        (instances (project "demo"
            (path "/${ROOT_UUID}" (page "${page}")))))`;
}

const root_sch_src = `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "${ROOT_UUID}")
    (paper "A4")
    (title_block (title "\${NAMEOFPROJECT}") (rev "\${REVISION}"))
    (lib_symbols)
    ${sheet(ALPHA_UUID, "Alpha", "A", "2")}
    ${sheet(BETA_UUID, "Beta", "B", "3")}
    (sheet_instances (path "/" (page "1"))))`;

const child_sch_src = `
(kicad_sch (version 20231120) (generator "eeschema")
    (uuid "cccccccc-0000-0000-0000-000000000001")
    (paper "A4")
    (title_block (rev "\${REVISION}"))
    (lib_symbols))`;

const project_src = JSON.stringify({
    meta: { filename: "demo.kicad_pro", version: 1 },
    sheets: [
        [ROOT_UUID, "Demo root"],
        [ALPHA_UUID, "Alpha"],
        [BETA_UUID, "Beta"],
    ],
    text_variables: { NAMEOFPROJECT: "Demo board", REVISION: "07" },
});

async function load_project(with_project_file = true) {
    const files = [
        // The board is listed first on purpose: it must not be mistaken for
        // the root schematic.
        new File([empty_pcb_src], "demo.kicad_pcb"),
        new File([root_sch_src], "demo.kicad_sch"),
        new File([child_sch_src], "child.kicad_sch"),
    ];
    if (with_project_file) {
        files.push(new File([project_src], "demo.kicad_pro"));
    }
    const fs = new LocalFileSystem(files);
    await fs.setup();
    const project = new Project();
    await project.load(fs);
    return project;
}

function page_named(project: Project, name: string) {
    const page = [...project.pages()].find((p) => p.name == name);
    assert.exists(page, `page ${name}`);
    return page!;
}

function show(project: Project, name: string) {
    const page = page_named(project, name);
    const doc = page.document as KicadSch;
    doc.update_hierarchical_data(page.sheet_path);
    return doc;
}

suite("kicad.text_vars: hierarchical schematic text variables", function () {
    test("root schematic page is a schematic even when a board is loaded", async function () {
        const project = await load_project();
        assert.equal(project.root_schematic_page?.type, "schematic");
        assert.equal(project.root_schematic_page?.filename, "demo.kicad_sch");
    });

    test("sheet name, path and number depend on the shown instance", async function () {
        const project = await load_project();
        const text = "${SHEETNAME}|${SHEETPATH}|${#}/${##}|${Variant}";

        const alpha = show(project, "Alpha");
        assert.equal(expand_text_vars(text, alpha), "Alpha|/Alpha/|2/3|A");

        // Same file, different sheet instance.
        const beta = show(project, "Beta");
        assert.strictEqual(alpha, beta);
        assert.equal(expand_text_vars(text, beta), "Beta|/Beta/|3/3|B");
    });

    test("root sheet", async function () {
        const project = await load_project();
        const root = show(project, "Root");
        assert.equal(
            expand_text_vars("${SHEETNAME}|${SHEETPATH}|${#}", root),
            "Demo root|/|1",
        );
    });

    test("title block fields expand project variables", async function () {
        const project = await load_project();
        const root = show(project, "Root");

        // rev is "${REVISION}" in the title block, which must resolve
        // through the project's text variables instead of being reported as
        // a cycle.
        assert.equal(root.resolve_text_var("REVISION"), "07");
        assert.equal(expand_text_vars("Rev: ${REVISION}", root), "Rev: 07");
        assert.equal(expand_text_vars("${TITLE}", root), "Demo board");
        assert.equal(
            expand_text_vars("${PROJECTNAME} ${NAMEOFPROJECT}", root),
            "demo Demo board",
        );
    });

    test("board resolves project variables", async function () {
        const project = await load_project();
        const board = project.file_by_name("demo.kicad_pcb") as KicadPCB;
        assert.equal(
            expand_text_vars("${PROJECTNAME} ${NAMEOFPROJECT}", board),
            "demo Demo board",
        );
    });

    test("unknown variables are left alone", async function () {
        const project = await load_project(false);
        const alpha = show(project, "Alpha");
        assert.equal(
            expand_text_vars("${NOPE} ${REVISION}", alpha),
            "${NOPE} ${REVISION}",
        );
        // Without a project file, the project is named after the root
        // schematic.
        assert.equal(expand_text_vars("${PROJECTNAME}", alpha), "demo");
    });
});
