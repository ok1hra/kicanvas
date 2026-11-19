/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { delegate } from "../../../base/events";
import { css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import {
    KiCanvasLayersChangedEvent,
    KiCanvasLoadEvent,
} from "../../../viewers/base/events";
import { LayerNames, LayerSet } from "../../../viewers/board/layers";
import { BoardViewer } from "../../../viewers/board/viewer";

/** Layer descriptions shown next to the names, as in KiCad. */
const descriptions: Record<string, string> = {
    "F.Cu": "Front copper",
    "B.Cu": "Back copper",
    "F.Adhes": "Adhesive on front",
    "B.Adhes": "Adhesive on back",
    "F.Paste": "Solder paste on front",
    "B.Paste": "Solder paste on back",
    "F.SilkS": "Silkscreen on front",
    "B.SilkS": "Silkscreen on back",
    "F.Mask": "Solder mask on front",
    "B.Mask": "Solder mask on back",
    "Dwgs.User": "User drawings",
    "Cmts.User": "User comments",
    "Eco1.User": "User ECO 1",
    "Eco2.User": "User ECO 2",
    "Edge.Cuts": "Board outline",
    Margin: "Board margin",
    "F.CrtYd": "Courtyard on front",
    "B.CrtYd": "Courtyard on back",
    "F.Fab": "Fabrication on front",
    "B.Fab": "Fabrication on back",
};

type Preset = { name: string; show: (layer: string) => boolean };

const presets: Preset[] = [
    {
        name: "Copper and outline",
        show: (l) => l.endsWith(".Cu") || l == LayerNames.edge_cuts,
    },
    { name: "All layers", show: () => true },
    {
        name: "Front layers",
        show: (l) => l.startsWith("F.") || l == LayerNames.edge_cuts,
    },
    {
        name: "Back layers",
        show: (l) => l.startsWith("B.") || l == LayerNames.edge_cuts,
    },
    {
        name: "Outer copper",
        show: (l) =>
            l == LayerNames.f_cu ||
            l == LayerNames.b_cu ||
            l == LayerNames.edge_cuts,
    },
    {
        name: "Inner copper",
        show: (l) =>
            (l.endsWith(".Cu") &&
                l != LayerNames.f_cu &&
                l != LayerNames.b_cu) ||
            l == LayerNames.edge_cuts,
    },
];

/**
 * Board layers and zone fill controls, laid out like the Layers tab of
 * KiCad's Appearance panel: color swatch, visibility eye and layer name.
 * Clicking a layer's name highlights it.
 */
export class KCBoardAppearancePanelElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                display: block;
                padding: 2px 0 4px;
                user-select: none;
            }

            .row {
                display: flex;
                align-items: center;
                gap: 5px;
                height: 19px;
                padding: 0 6px 0 4px;
                cursor: pointer;
                white-space: nowrap;
            }

            .row:hover {
                background: var(--fp-hover-bg, #48484b);
            }

            .row.highlighted {
                background: var(--fp-selected-bg, #2f5d8a);
                color: var(--fp-selected-fg, #fff);
            }

            .row.hidden .name,
            .row.hidden .desc {
                opacity: 0.45;
            }

            .swatch {
                flex: 0 0 auto;
                width: 11px;
                height: 11px;
                border: 1px solid rgba(255, 255, 255, 0.35);
                border-radius: 1px;
            }

            .eye {
                all: unset;
                flex: 0 0 auto;
                display: grid;
                place-items: center;
                width: 16px;
                height: 16px;
                border-radius: 2px;
                cursor: pointer;
                color: var(--fp-fg, #e4e4e4);
            }

            .eye:hover {
                background: rgba(255, 255, 255, 0.12);
            }

            .eye kc-ui-icon {
                font-size: 15px;
            }

            .row.hidden .eye {
                color: var(--fp-muted, #9a9a9a);
            }

            .name {
                flex: 0 0 auto;
                min-width: 62px;
            }

            .desc {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                color: var(--fp-muted, #9a9a9a);
            }

            .highlighted .desc {
                color: inherit;
            }

            hr {
                border: none;
                border-top: 1px solid var(--fp-border, #575757);
                margin: 4px 0;
            }

            .presets {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 2px 6px 0;
            }

            select {
                flex: 1;
                min-width: 0;
                font: inherit;
                color: var(--fp-fg, #e4e4e4);
                background: #222224;
                border: 1px solid var(--fp-border, #575757);
                border-radius: 2px;
                padding: 1px 2px;
            }
        `,
    ];

    viewer: BoardViewer;

    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;
            super.connectedCallback();
        })();
    }

    override initialContentCallback() {
        // The layer set is recreated whenever a board is loaded.
        this.addDisposable(
            this.viewer.addEventListener(KiCanvasLoadEvent.type, () =>
                this.update(),
            ),
        );
        this.addDisposable(
            this.viewer.addEventListener(KiCanvasLayersChangedEvent.type, () =>
                this.#sync(),
            ),
        );

        delegate(this.renderRoot, ".eye", "click", (e, source) => {
            e.stopPropagation();
            const row = source.closest(".row")!;
            const name = row.getAttribute("data-layer")!;

            if (name == "zone-fills") {
                this.viewer.zone_fills = !this.viewer.zone_fills;
                return;
            }

            const layer = this.viewer.layers.by_name(name);
            if (layer) {
                layer.visible = !layer.visible;
                this.viewer.draw();
                this.viewer.notify_layers_changed();
            }
        });

        delegate(this.renderRoot, ".row[data-layer]", "click", (e, source) => {
            const name = source.getAttribute("data-layer")!;
            if (name == "zone-fills") {
                this.viewer.zone_fills = !this.viewer.zone_fills;
                return;
            }

            const layers = this.viewer.layers;
            const layer = layers.by_name(name);
            if (!layer) {
                return;
            }

            if (layer.highlighted) {
                layers.highlight(null);
            } else {
                layers.highlight(layer);
                layer.visible = true;
            }
            this.viewer.draw();
            this.viewer.notify_layers_changed();
        });

        this.renderRoot
            .querySelector("select")
            ?.addEventListener("change", (e) => {
                const select = e.target as HTMLSelectElement;
                const preset = presets[parseInt(select.value, 10)];
                if (!preset) {
                    return;
                }
                for (const layer of (
                    this.viewer.layers as LayerSet
                ).in_ui_order()) {
                    layer.visible = preset.show(layer.name);
                }
                this.viewer.draw();
                this.viewer.notify_layers_changed();
            });
    }

    /** Updates row states without re-rendering. */
    #sync() {
        for (const row of this.renderRoot.querySelectorAll<HTMLElement>(
            ".row[data-layer]",
        )) {
            const name = row.getAttribute("data-layer")!;
            const visible =
                name == "zone-fills"
                    ? this.viewer.zone_fills
                    : (this.viewer.layers.by_name(name)?.visible ?? false);
            const highlighted =
                this.viewer.layers.by_name(name)?.highlighted ?? false;

            row.classList.toggle("hidden", !visible);
            row.classList.toggle("highlighted", highlighted);
            const icon = row.querySelector("kc-ui-icon");
            if (icon) {
                icon.textContent = visible ? "visibility" : "visibility_off";
            }
        }
    }

    #row(name: string, color: string, label: string, desc: string) {
        return html`<div class="row" data-layer="${name}">
            <span class="swatch" style="background: ${color}"></span>
            <button class="eye" type="button" title="Show / hide">
                <kc-ui-icon>visibility</kc-ui-icon>
            </button>
            <span class="name">${label}</span>
            <span class="desc">${desc}</span>
        </div>`;
    }

    override render() {
        const layers = this.viewer.layers as LayerSet;
        const rows = [];

        for (const layer of layers.in_ui_order()) {
            rows.push(
                this.#row(
                    layer.name,
                    layer.color.to_css(),
                    layer.name,
                    descriptions[layer.name] ??
                        (layer.name.endsWith(".Cu") ? "Inner copper" : ""),
                ),
            );
        }

        const root = html`${rows}
            <hr />
            ${this.#row("zone-fills", "transparent", "Zones", "Zone fills")}
            <hr />
            <div class="presets">
                <span>Presets</span>
                <select title="Layer presets">
                    <option value="" selected disabled>Choose…</option>
                    ${presets.map(
                        (p, i) => html`<option value="${i}">${p.name}</option>`,
                    )}
                </select>
            </div>`;

        // Sync after the rows are in the tree.
        window.requestAnimationFrame(() => this.#sync());
        return root;
    }
}

window.customElements.define(
    "kc-board-appearance-panel",
    KCBoardAppearancePanelElement,
);
