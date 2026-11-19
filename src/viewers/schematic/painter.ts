/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import {
    Angle,
    BBox,
    Arc as MathArc,
    Matrix3,
    Vec2,
    cubic_bezier_points,
} from "../../base/math";
import {
    Arc,
    Circle,
    Color,
    Polygon,
    Polyline,
    Renderer,
} from "../../graphics";
import type { SchematicTheme } from "../../kicad";
import { Stroke, type StrokeParams } from "../../kicad/common";
import * as schematic_items from "../../kicad/schematic";
import {
    EDAText,
    LibText,
    SchField,
    SchText,
    StrokeFont,
} from "../../kicad/text";
import { StrokePainter } from "../base/painter";
import { LayerNames, LayerSet, ViewLayer } from "./layers";
import { BaseSchematicPainter, SchematicItemPainter } from "./painters/base";
import {
    GlobalLabelPainter,
    HierarchicalLabelPainter,
    DirectiveLabelPainter,
    NetLabelPainter,
} from "./painters/label";
import { PinPainter } from "./painters/pin";
import { LibSymbolPainter, SchematicSymbolPainter } from "./painters/symbol";

class RectanglePainter extends SchematicItemPainter {
    classes = [schematic_items.Rectangle];

    layers_for(item: schematic_items.Rectangle) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, r: schematic_items.Rectangle) {
        const pts = [
            r.start,
            new Vec2(r.end.x, r.start.y),
            r.end,
            new Vec2(r.start.x, r.end.y),
            r.start,
        ];

        this.#fill(layer, r, pts);
        this.#stroke(layer, r, pts);
    }

    #stroke(layer: ViewLayer, r: schematic_items.Rectangle, pts: Vec2[]) {
        const { width, color } = this.determine_stroke(layer, r);

        if (!width || !color) {
            return;
        }

        this.gfx.line(
            new Polyline(
                pts,
                r.stroke?.width || this.gfx.state.stroke_width,
                color,
            ),
        );
    }

    #fill(layer: ViewLayer, r: schematic_items.Rectangle, pts: Vec2[]) {
        const color = this.determine_fill(layer, r);

        if (!color) {
            return;
        }

        this.gfx.polygon(new Polygon(pts, color));
    }
}

class PolylinePainter extends SchematicItemPainter {
    classes = [schematic_items.Polyline];

    layers_for(item: schematic_items.Polyline) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, pl: schematic_items.Polyline) {
        this.#fill(layer, pl);
        this.#stroke(layer, pl);
    }

    #stroke(layer: ViewLayer, pl: schematic_items.Polyline) {
        const { width, color } = this.determine_stroke(layer, pl);

        if (!width || !color) {
            return;
        }

        const draw_line = (lines: Vec2[]) => {
            this.gfx.line(lines, width, color);
        };

        StrokePainter.line(pl.pts, width, pl.stroke_params, draw_line);
    }

    #fill(layer: ViewLayer, pl: schematic_items.Polyline) {
        const color = this.determine_fill(layer, pl);

        if (!color) {
            return;
        }

        this.gfx.polygon(new Polygon(pl.pts, color));
    }
}

/** Decoded images, shared between paints. */
const decoded_images = new WeakMap<schematic_items.Image, HTMLImageElement>();

/** Fired on window when an image finished decoding, so viewers redraw. */
export const image_loaded_event = "kicanvas:image-loaded";

class ImagePainter extends SchematicItemPainter {
    classes = [schematic_items.Image];

    layers_for(item: schematic_items.Image) {
        return [LayerNames.bitmap];
    }

    paint(layer: ViewLayer, image: schematic_items.Image) {
        const size = image.size;
        if (!size || !image.data) {
            return;
        }

        let element = decoded_images.get(image);
        if (!element) {
            element = new window.Image();
            element.addEventListener("load", () =>
                window.dispatchEvent(new Event(image_loaded_event)),
            );
            element.src = image.data_url;
            decoded_images.set(image, element);
        }

        // Images are centered on their position.
        const center = image.at.position;
        this.gfx.image(
            element,
            new BBox(
                center.x - size.x / 2,
                center.y - size.y / 2,
                size.x,
                size.y,
            ),
        );
    }
}

class BezierPainter extends SchematicItemPainter {
    classes = [schematic_items.Bezier];

    layers_for(item: schematic_items.Bezier) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, b: schematic_items.Bezier) {
        const [p0, p1, p2, p3] = b.pts;
        if (!p0 || !p1 || !p2 || !p3) {
            return;
        }
        const pts = cubic_bezier_points(p0, p1, p2, p3);

        const fill = this.determine_fill(layer, b);
        if (fill) {
            this.gfx.polygon(new Polygon(pts, fill));
        }

        const { width, color } = this.determine_stroke(layer, b);
        if (width && color) {
            StrokePainter.line(pts, width, b.stroke_params, (lines) =>
                this.gfx.line(lines, width, color),
            );
        }
    }
}

class RuleAreaPainter extends SchematicItemPainter {
    classes = [schematic_items.RuleArea];

    layers_for(item: schematic_items.RuleArea) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, item: schematic_items.RuleArea) {
        const pts = [...item.polyline.pts, item.polyline.pts[0]!.copy()];

        // fill polyline
        const fill_color = this.determine_fill(layer, item.polyline);
        if (fill_color) {
            this.gfx.polygon(new Polygon(pts, fill_color));
        }

        // polyline outline
        const outline_width =
            item.polyline.stroke?.width || this.gfx.state.stroke_width;

        const outline_color =
            item.polyline.stroke?.color || this.theme.rule_area;

        if (outline_width && outline_color) {
            const draw_line = (lines: Vec2[]) => {
                this.gfx.line(lines, outline_width, outline_color);
            };

            StrokePainter.line(
                pts,
                outline_width,
                item.polyline.stroke_params,
                draw_line,
            );
        }
    }
}

class WirePainter extends SchematicItemPainter {
    classes = [schematic_items.Wire];

    layers_for(item: schematic_items.Wire) {
        return [LayerNames.wire];
    }

    paint(layer: ViewLayer, w: schematic_items.Wire) {
        this.gfx.line(
            new Polyline(w.pts, this.gfx.state.stroke_width, this.theme.wire),
        );
    }
}

class BusPainter extends SchematicItemPainter {
    classes = [schematic_items.Bus];

    layers_for(item: schematic_items.Bus) {
        return [LayerNames.wire];
    }

    paint(layer: ViewLayer, w: schematic_items.Bus) {
        this.gfx.line(
            new Polyline(
                w.pts,
                schematic_items.DefaultValues.bus_width,
                this.theme.bus,
            ),
        );
    }
}

class BusEntryPainter extends SchematicItemPainter {
    classes = [schematic_items.BusEntry];

    layers_for(item: schematic_items.BusEntry) {
        return [LayerNames.junction];
    }

    paint(layer: ViewLayer, be: schematic_items.BusEntry) {
        this.gfx.line(
            new Polyline(
                [be.at.position, be.at.position.add(be.size)],
                schematic_items.DefaultValues.wire_width,
                this.theme.wire,
            ),
        );
    }
}

class CirclePainter extends SchematicItemPainter {
    classes = [schematic_items.Circle];

    layers_for(item: schematic_items.Circle) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, c: schematic_items.Circle) {
        this.#fill(layer, c);
        this.#stroke(layer, c);
    }

    #stroke(layer: ViewLayer, c: schematic_items.Circle) {
        const { width, color } = this.determine_stroke(layer, c);

        if (!width || !color) {
            return;
        }

        this.gfx.arc(
            new Arc(
                c.center,
                c.radius,
                new Angle(0),
                new Angle(Math.PI * 2),
                width,
                color,
            ),
        );
    }

    #fill(layer: ViewLayer, c: schematic_items.Circle) {
        const color = this.determine_fill(layer, c);

        if (!color) {
            return;
        }

        this.gfx.circle(new Circle(c.center, c.radius, color));
    }
}

class ArcPainter extends SchematicItemPainter {
    classes = [schematic_items.Arc];

    layers_for(item: schematic_items.Arc) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, a: schematic_items.Arc) {
        const arc = MathArc.from_three_points(
            a.start,
            a.mid,
            a.end,
            a.stroke?.width,
        );

        this.#fill(layer, a, arc);
        this.#stroke(layer, a, arc);
    }

    #stroke(layer: ViewLayer, a: schematic_items.Arc, arc: MathArc) {
        const { width, color } = this.determine_stroke(layer, a);

        if (!width || !color) {
            return;
        }

        this.gfx.arc(
            new Arc(
                arc.center,
                arc.radius,
                arc.start_angle,
                arc.end_angle,
                width,
                color,
            ),
        );
    }

    #fill(layer: ViewLayer, a: schematic_items.Arc, arc: MathArc) {
        const color = this.determine_fill(layer, a);

        if (!color) {
            return;
        }

        this.gfx.polygon(new Polygon(arc.to_polygon(), color));
    }
}

class JunctionPainter extends SchematicItemPainter {
    classes = [schematic_items.Junction];

    layers_for(item: schematic_items.Junction) {
        return [LayerNames.junction];
    }

    paint(layer: ViewLayer, j: schematic_items.Junction) {
        const color = this.theme.junction;
        this.gfx.circle(
            new Circle(j.at.position, (j.diameter || 1) / 2, color),
        );
    }
}

class NoConnectPainter extends SchematicItemPainter {
    classes = [schematic_items.NoConnect];

    layers_for(item: schematic_items.NoConnect) {
        return [LayerNames.junction];
    }

    paint(layer: ViewLayer, nc: schematic_items.NoConnect): void {
        const color = this.theme.no_connect;
        const width = schematic_items.DefaultValues.line_width;
        const size = schematic_items.DefaultValues.noconnect_size / 2;

        this.gfx.state.push();
        this.gfx.state.matrix.translate_self(
            nc.at.position.x,
            nc.at.position.y,
        );

        this.gfx.line(
            new Polyline(
                [new Vec2(-size, -size), new Vec2(size, size)],
                width,
                color,
            ),
        );

        this.gfx.line(
            new Polyline(
                [new Vec2(size, -size), new Vec2(-size, size)],
                width,
                color,
            ),
        );

        this.gfx.state.pop();
    }
}

class TextPainter extends SchematicItemPainter {
    classes = [schematic_items.Text];

    layers_for(item: schematic_items.Text) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, t: schematic_items.Text) {
        if (t.effects.hide || !t.text) {
            return;
        }

        const schtext = new SchText(t.shown_text);

        schtext.apply_at(t.at);
        schtext.apply_effects(t.effects);

        const font_color = t.effects.font.color;
        if (font_color.is_transparent_black) {
            // The color was not specified.
            const text_color = this.theme.note;
            schtext.attributes.color = this.dim_if_needed(text_color);
        } else {
            schtext.attributes.color = this.dim_if_needed(font_color);
        }

        this.gfx.state.push();
        StrokeFont.default().draw(
            this.gfx,
            schtext.shown_text,
            schtext.text_pos,
            schtext.attributes,
        );
        this.gfx.state.pop();
    }
}

type TableStroke = { width: number; color: Color; params: StrokeParams };

/**
 * Paints schematic tables: cell fills, cell text and the border and
 * separator lines. See SCH_TABLE::DrawBorders and SCH_TEXTBOX::GetDrawPos.
 */
class TablePainter extends SchematicItemPainter {
    classes = [schematic_items.Table];

    layers_for(item: schematic_items.Table) {
        return [LayerNames.notes];
    }

    paint(layer: ViewLayer, table: schematic_items.Table) {
        const cells = table.cells.filter((c) => !c.covered && c.at && c.size);

        for (const cell of cells) {
            this.#paint_cell_fill(cell);
        }

        this.#paint_borders(table);

        for (const cell of cells) {
            this.#paint_cell_text(cell);
        }
    }

    #cell_bbox(cell: schematic_items.TableCell) {
        const { x, y } = cell.at.position;
        return BBox.from_corners(x, y, x + cell.size.x, y + cell.size.y);
    }

    #paint_cell_fill(cell: schematic_items.TableCell) {
        if (cell.fill?.type != "color" || !cell.fill.color) {
            return;
        }
        this.gfx.polygon(
            Polygon.from_BBox(
                this.#cell_bbox(cell),
                this.dim_if_needed(cell.fill.color),
            ),
        );
    }

    #stroke_for(stroke?: Stroke): TableStroke {
        const width = stroke?.width || this.gfx.state.stroke_width;
        let color = this.theme.note;
        if (stroke?.color && !stroke.color.is_transparent_black) {
            color = stroke.color;
        }
        return {
            width,
            color: this.dim_if_needed(color),
            params: {
                stroke: stroke ?? Stroke.default_value(),
                dashed_line_gap_ratio: 3,
                dashed_line_dash_ratio: 12,
            },
        };
    }

    #line(pts: Vec2[], stroke: TableStroke): void {
        StrokePainter.line(pts, stroke.width, stroke.params, (lines) =>
            this.gfx.line(lines, stroke.width, stroke.color),
        );
    }

    #paint_borders(table: schematic_items.Table) {
        const rows = table.row_count;
        const cols = table.column_count;
        const first = table.cell(0, 0);

        if (!first?.at || !first.size) {
            return;
        }

        const separators = this.#stroke_for(table.separators.stroke);

        if (table.separators.cols) {
            for (let col = 0; col < cols - 1; col++) {
                for (let row = 0; row < rows; row++) {
                    const cell = table.cell(row, col);
                    if (!cell?.at || !cell.size || cell.covered) continue;
                    const bb = this.#cell_bbox(cell);
                    // Don't draw separators through cells spanning columns.
                    if (col + (cell.span[0] ?? 1) - 1 >= cols - 1) continue;
                    this.#line(
                        [new Vec2(bb.x2, bb.y), new Vec2(bb.x2, bb.y2)],
                        separators,
                    );
                }
            }
        }

        if (table.separators.rows) {
            // The first row's separator is the header line, drawn below.
            const start_row = table.border.header ? 1 : 0;
            for (let row = start_row; row < rows - 1; row++) {
                for (let col = 0; col < cols; col++) {
                    const cell = table.cell(row, col);
                    if (!cell?.at || !cell.size || cell.covered) continue;
                    const bb = this.#cell_bbox(cell);
                    if (row + (cell.span[1] ?? 1) - 1 >= rows - 1) continue;
                    this.#line(
                        [new Vec2(bb.x, bb.y2), new Vec2(bb.x2, bb.y2)],
                        separators,
                    );
                }
            }
        }

        const border = this.#stroke_for(table.border.stroke);
        const last = table.cells.at(-1)!;
        const outline = BBox.combine([
            this.#cell_bbox(first),
            ...table.cells
                .filter((c) => c.at && c.size && !c.covered)
                .map((c) => this.#cell_bbox(c)),
            this.#cell_bbox(last),
        ]);

        if (table.border.header && rows > 1) {
            const y = this.#cell_bbox(first).y2;
            this.#line(
                [new Vec2(outline.x, y), new Vec2(outline.x2, y)],
                border,
            );
        }

        if (table.border.external) {
            this.#line(
                [
                    new Vec2(outline.x, outline.y),
                    new Vec2(outline.x2, outline.y),
                    new Vec2(outline.x2, outline.y2),
                    new Vec2(outline.x, outline.y2),
                    new Vec2(outline.x, outline.y),
                ],
                border,
            );
        }
    }

    #paint_cell_text(cell: schematic_items.TableCell) {
        const shown = cell.shown_text;
        if (cell.effects.hide || !shown) {
            return;
        }

        const text = new EDAText(shown);
        text.apply_effects(cell.effects);
        text.text_angle = Angle.from_degrees(cell.at.rotation);

        const bb = this.#cell_bbox(cell);
        const [ml = 0, mt = 0, mr = 0, mb = 0] = cell.margins;

        // Wrap to the cell's width, like SCH_TEXTBOX::GetShownText.
        const column_width = text.text_angle.is_vertical
            ? bb.h - mt - mb
            : bb.w - ml - mr;
        text.text = StrokeFont.default().break_lines(
            shown,
            column_width * 10000,
            text.attributes.size,
            text.attributes.stroke_width,
            text.attributes.bold,
            text.attributes.italic,
        );
        const pos = new Vec2(bb.x + ml, bb.y2 - mb);

        // Same as SCH_TEXTBOX::GetDrawPos.
        if (text.text_angle.is_vertical) {
            switch (text.h_align) {
                case "left":
                    pos.y = bb.y2 - mb;
                    break;
                case "center":
                    pos.y = (bb.y + bb.y2) / 2;
                    break;
                case "right":
                    pos.y = bb.y + mt;
                    break;
            }
            switch (text.v_align) {
                case "top":
                    pos.x = bb.x + ml;
                    break;
                case "center":
                    pos.x = (bb.x + bb.x2) / 2;
                    break;
                case "bottom":
                    pos.x = bb.x2 - mr;
                    break;
            }
        } else {
            switch (text.h_align) {
                case "left":
                    pos.x = bb.x + ml;
                    break;
                case "center":
                    pos.x = (bb.x + bb.x2) / 2;
                    break;
                case "right":
                    pos.x = bb.x2 - mr;
                    break;
            }
            switch (text.v_align) {
                case "top":
                    pos.y = bb.y + mt;
                    break;
                case "center":
                    pos.y = (bb.y + bb.y2) / 2;
                    break;
                case "bottom":
                    pos.y = bb.y2 - mb;
                    break;
            }
        }

        text.text_pos = pos.multiply(10000);

        const font_color = cell.effects.font.color;
        text.attributes.color = this.dim_if_needed(
            font_color.is_transparent_black ? this.theme.note : font_color,
        );

        this.gfx.state.push();
        StrokeFont.default().draw(
            this.gfx,
            text.shown_text,
            text.text_pos,
            text.attributes,
        );
        this.gfx.state.pop();
    }
}

class PropertyPainter extends SchematicItemPainter {
    classes = [schematic_items.Property];

    layers_for(item: schematic_items.Property) {
        return [LayerNames.symbol_field, LayerNames.interactive];
    }

    paint(layer: ViewLayer, p: schematic_items.Property) {
        if (p.hide || !p.text) {
            return;
        }

        let color = this.theme.fields;
        if (p.parent instanceof schematic_items.SchematicSheet) {
            color = this.theme.sheet_fields;
        }

        const font_color = p.effects.font.color;
        if (font_color.is_transparent_black) {
            // The color was not specified.
            switch (p.name) {
                case "Reference":
                    color = this.theme.reference;
                    break;
                case "Value":
                    color = this.theme.value;
                    break;
                case "Sheet name":
                    color = this.theme.sheet_name;
                    break;
                case "Sheet file":
                    color = this.theme.sheet_filename;
                    break;
            }

            color = this.dim_if_needed(color);
        } else {
            color = this.dim_if_needed(font_color);
        }

        const parent = p.parent as schematic_items.SchematicSymbol;
        const transform = this.view_painter.current_symbol_transform;
        const matrix = transform?.matrix ?? Matrix3.identity();

        let text = p.shown_text;

        if (p.name == "Reference" && parent.unit) {
            text += parent.unit_suffix;
        }

        const schfield = new SchField(text, {
            position: parent.at.position.multiply(10000),
            transform: matrix,
            is_symbol: parent instanceof schematic_items.SchematicSymbol,
        });

        schfield.apply_effects(p.effects);
        schfield.attributes.angle = Angle.from_degrees(p.at.rotation);

        // Position is tricky. KiCad's parser calls into SCH_FIELD::SetPosition
        // when parsing which sets the position relative to the parent transform
        // but KiCanvas doesn't do any of that. So we have to do that transform
        // here.
        let rel_position = p.at.position
            .multiply(10000)
            .sub(schfield.parent!.position);
        rel_position = matrix.inverse().transform(rel_position);
        rel_position = rel_position.add(schfield.parent!.position);

        schfield.text_pos = rel_position;

        const orient = schfield.draw_rotation;
        const bbox = schfield.bounding_box;
        const pos = bbox.center;

        schfield.attributes.angle = orient;
        schfield.attributes.h_align = "center";
        schfield.attributes.v_align = "center";
        schfield.attributes.stroke_width =
            schfield.get_effective_text_thickness(
                schematic_items.DefaultValues.line_width * 10000,
            );
        schfield.attributes.color = color;

        const bbox_pts = Matrix3.scaling(0.0001, 0.0001).transform_all([
            bbox.top_left,
            bbox.top_right,
            bbox.bottom_right,
            bbox.bottom_left,
            bbox.top_left,
        ]);

        if (layer.name == LayerNames.interactive) {
            // Drawing text is expensive, just draw the bbox for the interactive layer.
            this.gfx.line(new Polyline(Array.from(bbox_pts), 0.1, Color.white));
        } else {
            this.gfx.state.push();
            StrokeFont.default().draw(
                this.gfx,
                schfield.shown_text,
                pos,
                schfield.attributes,
            );
            this.gfx.state.pop();
        }
    }
}

class LibTextPainter extends SchematicItemPainter {
    classes = [schematic_items.LibText];

    layers_for(item: schematic_items.LibText) {
        return [LayerNames.symbol_foreground];
    }

    paint(layer: ViewLayer, lt: schematic_items.LibText) {
        if (lt.effects.hide || !lt.text) {
            return;
        }

        const current_symbol_transform =
            this.view_painter.current_symbol_transform!;

        const libtext = new LibText(lt.shown_text);

        libtext.apply_effects(lt.effects);
        libtext.apply_at(lt.at);
        libtext.apply_symbol_transformations(current_symbol_transform);

        libtext.attributes.color = this.dim_if_needed(
            this.theme.component_outline,
        );

        // This gets the absolute world coordinates where the text should
        // be drawn.
        const pos = libtext.world_pos;

        // world_pos already applies v_align, so set it to center to draw
        // the text in the right spot.
        // Note: I'm not sure why it doesn't clear h_align like SchField
        // does.
        libtext.attributes.v_align = "center";

        this.gfx.state.push();
        this.gfx.state.matrix = Matrix3.identity();

        StrokeFont.default().draw(
            this.gfx,
            libtext.shown_text,
            pos,
            libtext.attributes,
        );

        // this.paint_debug(bbox);

        this.gfx.state.pop();
    }

    paint_debug(bbox: BBox) {
        this.gfx.line(
            Polyline.from_BBox(
                bbox.scale(1 / 10000),
                0.127,
                new Color(0, 0, 1, 1),
            ),
        );

        this.gfx.circle(
            new Circle(
                bbox.center.multiply(1 / 10000),
                0.2,
                new Color(0, 1, 0, 1),
            ),
        );
    }
}

class SchematicSheetPainter extends SchematicItemPainter {
    classes = [schematic_items.SchematicSheet];

    layers_for(item: schematic_items.SchematicSheet) {
        return [
            LayerNames.interactive,
            LayerNames.label,
            LayerNames.symbol_foreground,
            LayerNames.symbol_background,
            LayerNames.symbol_field,
        ];
    }

    paint(layer: ViewLayer, ss: schematic_items.SchematicSheet) {
        const outline_color = this.theme.sheet;
        const fill_color = this.theme.sheet_background;
        const bbox = new BBox(
            ss.at.position.x,
            ss.at.position.y,
            ss.size.x,
            ss.size.y,
        );

        if (layer.name == LayerNames.interactive) {
            this.gfx.polygon(Polygon.from_BBox(bbox.grow(3), fill_color));
        }

        if (layer.name == LayerNames.symbol_background) {
            this.gfx.polygon(Polygon.from_BBox(bbox, fill_color));
        }

        if (layer.name == LayerNames.symbol_foreground) {
            this.gfx.line(
                Polyline.from_BBox(
                    bbox,
                    this.gfx.state.stroke_width,
                    outline_color,
                ),
            );
        }

        if (layer.name == LayerNames.symbol_field) {
            for (const property of ss.properties.values()) {
                this.view_painter.paint_item(layer, property);
            }
        }

        if (layer.name == LayerNames.label) {
            for (const pin of ss.pins) {
                const label = new schematic_items.HierarchicalLabel();
                label.at = pin.at.copy();
                label.effects = pin.effects;
                label.text = pin.name;
                label.shape = pin.shape;

                switch (label.at.rotation) {
                    case 0:
                        label.at.rotation = 180;
                        break;
                    case 180:
                        label.at.rotation = 0;
                        break;
                    case 90:
                        label.at.rotation = 270;
                        break;
                    case 270:
                        label.at.rotation = 90;
                        break;
                }

                if (pin.shape == "input") {
                    label.shape = "output";
                } else if (pin.shape == "output") {
                    label.shape = "input";
                }

                this.view_painter.paint_item(layer, label);
            }
        }
    }
}

export class SchematicPainter extends BaseSchematicPainter {
    override theme: SchematicTheme;

    constructor(gfx: Renderer, layers: LayerSet, theme: SchematicTheme) {
        super(gfx, layers, theme);
        this.painter_list = [
            new RectanglePainter(this, gfx),
            new PolylinePainter(this, gfx),
            new BezierPainter(this, gfx),
            new ImagePainter(this, gfx),
            new RuleAreaPainter(this, gfx),
            new WirePainter(this, gfx),
            new BusPainter(this, gfx),
            new BusEntryPainter(this, gfx),
            new CirclePainter(this, gfx),
            new ArcPainter(this, gfx),
            new JunctionPainter(this, gfx),
            new NoConnectPainter(this, gfx),
            new TextPainter(this, gfx),
            new TablePainter(this, gfx),
            new LibTextPainter(this, gfx),
            new PinPainter(this, gfx),
            new LibSymbolPainter(this, gfx),
            new PropertyPainter(this, gfx),
            new SchematicSymbolPainter(this, gfx),
            new NetLabelPainter(this, gfx),
            new DirectiveLabelPainter(this, gfx),
            new GlobalLabelPainter(this, gfx),
            new HierarchicalLabelPainter(this, gfx),
            new SchematicSheetPainter(this, gfx),
        ];
    }
}
