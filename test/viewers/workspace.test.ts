/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { assert } from "chai";
import { KicadPCB } from "../../src/kicad/board";
import themes from "../../src/kicanvas/themes";
import type {
    KCUIDividerElement,
    KCUIFloatingSectionElement,
} from "../../src/kc-ui";
// Registers the custom elements.
import "../../src/kc-ui";
import {
    CopperVirtualLayerNames,
    LayerSet,
    virtual_layer_for,
} from "../../src/viewers/board/layers";

import zones_pcb_src from "../kicad/files/zones.kicad_pcb";

const outline_board_src = `
(kicad_pcb (version 20240108) (generator "pcbnew")
    (general (thickness 1.6))
    (paper "A4")
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
    (net 0 "")
    (gr_rect (start 100 100) (end 150 130) (stroke (width 0.1) (type solid))
        (fill none) (layer "Edge.Cuts") (uuid "11111111-1111-1111-1111-111111111111"))
)`;

suite("workspace: board display defaults", function () {
    test("edge_cuts_bbox covers only the outline", function () {
        const pcb = new KicadPCB("outline.kicad_pcb", outline_board_src);
        const bbox = pcb.edge_cuts_bbox;
        // It used to always include the origin.
        assert.closeTo(bbox.x, 100, 0.2);
        assert.closeTo(bbox.y, 100, 0.2);
        assert.closeTo(bbox.x2, 150, 0.2);
        assert.closeTo(bbox.y2, 130, 0.2);
    });

    test("edge_cuts_bbox is empty without an outline", function () {
        const pcb = new KicadPCB("zones.kicad_pcb", zones_pcb_src);
        const has_outline = pcb.drawings.some((d) => d.layer == "Edge.Cuts");
        assert.equal(pcb.edge_cuts_bbox.valid, has_outline);
    });

    test("zone fills can be swapped for outlines", function () {
        const pcb = new KicadPCB("zones.kicad_pcb", zones_pcb_src);
        const layers = new LayerSet(pcb, themes.default.board);
        const fills = layers.by_name(
            virtual_layer_for("F.Cu", CopperVirtualLayerNames.zones),
        )!;
        const outlines = layers.by_name(
            virtual_layer_for("F.Cu", CopperVirtualLayerNames.zone_outlines),
        )!;

        assert.isTrue(fills.visible);
        assert.isFalse(outlines.visible);

        layers.show_zone_fills = false;
        assert.isFalse(fills.visible);
        assert.isTrue(outlines.visible);

        // Both follow the copper layer's visibility.
        layers.by_name("F.Cu")!.visible = false;
        assert.isFalse(fills.visible);
        assert.isFalse(outlines.visible);
    });
});

suite("workspace: kc-ui elements", function () {
    test("divider sets the left pane's share and clamps it", function () {
        const parent = document.createElement("div");
        parent.style.display = "flex";
        parent.style.width = "1000px";
        const left = document.createElement("div");
        const divider = document.createElement(
            "kc-ui-divider",
        ) as KCUIDividerElement;
        const right = document.createElement("div");
        parent.append(left, divider, right);
        document.body.append(parent);

        try {
            assert.closeTo(divider.ratio, 0.5, 1e-6);

            divider.ratio = 0.3;
            assert.equal(parseFloat(left.style.flexBasis), 30);

            divider.ratio = 0.99;
            assert.closeTo(divider.ratio, 1 - divider.min_ratio, 1e-6);
        } finally {
            parent.remove();
        }
    });

    test("floating section opens and closes", async function () {
        const section = document.createElement(
            "kc-ui-floating-section",
        ) as KCUIFloatingSectionElement;
        section.setAttribute("heading", "Layers");
        section.append(document.createTextNode("content"));
        document.body.append(section);

        try {
            // Wait for the first render. (Not requestAnimationFrame, which
            // doesn't run in background tabs.)
            for (let i = 0; i < 100; i++) {
                if (section.shadowRoot?.querySelector(".head")) {
                    break;
                }
                await new Promise((r) => setTimeout(r, 10));
            }
            assert.isFalse(section.open);

            const head = section.shadowRoot!.querySelector(
                ".head",
            ) as HTMLElement;
            head.click();
            assert.isTrue(section.open);
            assert.isTrue(section.hasAttribute("open"));

            head.click();
            assert.isFalse(section.open);
        } finally {
            section.remove();
        }
    });
});
