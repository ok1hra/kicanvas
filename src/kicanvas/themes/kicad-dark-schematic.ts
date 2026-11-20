/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Color } from "../../base/color";
import type { SchematicTheme } from "../../kicad/theme";
import kicad_default from "./kicad-default";

/**
 * A dark version of KiCad's default schematic colors: the same hues, made
 * lighter so they read well on a dark background.
 */
const kicad_dark_schematic: SchematicTheme = {
    ...kicad_default.schematic,
    anchor: Color.from_css("rgb(110, 150, 255)"),
    aux_items: Color.from_css("rgb(210, 210, 210)"),
    background: Color.from_css("rgb(28, 29, 32)"),
    brightened: Color.from_css("rgb(255, 90, 255)"),
    bus: Color.from_css("rgb(110, 150, 255)"),
    bus_junction: Color.from_css("rgb(110, 150, 255)"),
    component_body: Color.from_css("rgb(58, 54, 34)"),
    component_outline: Color.from_css("rgb(225, 105, 100)"),
    cursor: Color.from_css("rgb(230, 230, 230)"),
    fields: Color.from_css("rgb(205, 125, 205)"),
    grid: Color.from_css("rgb(78, 80, 86)"),
    grid_axes: Color.from_css("rgb(110, 150, 255)"),
    junction: Color.from_css("rgb(70, 200, 70)"),
    label_global: Color.from_css("rgb(235, 115, 110)"),
    label_hier: Color.from_css("rgb(215, 185, 95)"),
    label_local: Color.from_css("rgb(225, 225, 225)"),
    netclass_flag: Color.from_css("rgb(175, 175, 175)"),
    no_connect: Color.from_css("rgb(110, 150, 255)"),
    note: Color.from_css("rgb(125, 160, 255)"),
    pin: Color.from_css("rgb(225, 105, 100)"),
    pin_name: Color.from_css("rgb(95, 200, 200)"),
    pin_number: Color.from_css("rgb(235, 115, 110)"),
    reference: Color.from_css("rgb(95, 200, 200)"),
    shadow: Color.from_css("rgba(100, 150, 210, 0.6)"),
    sheet: Color.from_css("rgb(225, 105, 100)"),
    sheet_fields: Color.from_css("rgb(205, 125, 205)"),
    sheet_filename: Color.from_css("rgb(215, 185, 95)"),
    sheet_label: Color.from_css("rgb(95, 200, 200)"),
    sheet_name: Color.from_css("rgb(95, 200, 200)"),
    value: Color.from_css("rgb(95, 200, 200)"),
    wire: Color.from_css("rgb(70, 200, 70)"),
    worksheet: Color.from_css("rgb(185, 95, 95)"),
};

export default kicad_dark_schematic;
