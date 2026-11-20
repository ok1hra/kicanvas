/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { html } from "../../../base/web-components";
import { KicadPCB } from "../../../kicad";
import type { KCUIButtonElement } from "../../../kc-ui";
import { KiCanvasLayersChangedEvent } from "../../../viewers/base/events";
import type { BoardViewer } from "../../../viewers/board/viewer";
import type { ProjectPage } from "../../project";
import { KCViewerAppElement } from "../common/app";
import { KCBoardViewerElement } from "./viewer";

// Import dependent elements so they're registered before use.
import "../common/help-panel";
import "../common/preferences-panel";
import "../common/viewer-bottom-toolbar";
import "./appearance-panel";
import { KCBoardMeasureElement } from "./measure";
import "./footprints-panel";
import "./info-panel";
import "./layers-panel";
import "./nets-panel";
import "./objects-panel";
import "./properties-panel";
import "./viewer";

/**
 * Internal "parent" element for KiCanvas's board viewer. Handles
 * setting up the actual board viewer as well as interface controls. It's
 * basically KiCanvas's version of PCBNew.
 */
export class KCBoardAppElement extends KCViewerAppElement<KCBoardViewerElement> {
    override on_viewer_select(item?: unknown, previous?: unknown) {
        // Selecting the same item twice should show the properties panel.
        // In floating mode the part info card already shows them.
        if (item && item == previous && !this.floating) {
            this.change_activity("properties");
        }
    }

    override can_load(src: ProjectPage): boolean {
        return src.document instanceof KicadPCB;
    }

    protected override initial_page() {
        const active = this.project.active_page;
        if (active && this.can_load(active)) {
            return active;
        }
        return [...this.project.pages()].find((p) => this.can_load(p));
    }

    override async load(src: ProjectPage) {
        await super.load(src);
        if (this.floating && this.current_page == src) {
            // Start with copper, the board outline, silkscreen and
            // courtyards, which is what matters most when cross-checking
            // against the schematic, and zone outlines instead of fills so
            // the traces are visible.
            const viewer = this.viewer as BoardViewer;
            viewer.show_default_layers();
            viewer.zone_fills = false;
        }
    }

    protected override get menu_heading() {
        return "Board";
    }

    #measure?: KCBoardMeasureElement;

    protected override make_overlays() {
        this.#measure =
            html`<kc-board-measure></kc-board-measure>` as KCBoardMeasureElement;
        // Keep the button in sync, also when toggled with the keyboard.
        this.#measure.addEventListener(
            KCBoardMeasureElement.change_event,
            (e) => {
                const button = this.button("measure");
                if (button) {
                    button.selected = (e as CustomEvent<boolean>).detail;
                }
            },
        );
        return [this.#measure];
    }

    protected override make_toolbar_buttons() {
        return [
            this.toolbar_button(
                "measure",
                "Measure distances and angles (M)",
                "straighten",
            ),
            this.toolbar_button(
                "zone_fills",
                "Zone fills",
                "format_color_fill",
            ),
            this.toolbar_button("flip_view", "Flip board view", "flip"),
        ];
    }

    protected override on_button(name: string, button: KCUIButtonElement) {
        const viewer = this.viewer as BoardViewer;
        switch (name) {
            case "zone_fills":
                viewer.zone_fills = !viewer.zone_fills;
                return true;
            case "measure":
                this.#measure?.toggle();
                return true;
        }
        return false;
    }

    override initialContentCallback() {
        super.initialContentCallback();
        // Keep the zone fill button in sync, also when changed from the
        // layers menu.
        this.addDisposable(
            this.viewer.addEventListener(
                KiCanvasLayersChangedEvent.type,
                () => {
                    const button = this.button("zone_fills");
                    if (button) {
                        button.selected = (
                            this.viewer as BoardViewer
                        ).zone_fills;
                    }
                },
            ),
        );
    }

    protected override get menu_anchor(): "left" | "right" {
        return "right";
    }

    protected override make_sections() {
        return [
            this.section(
                "layers",
                "Layers",
                html`<kc-board-appearance-panel></kc-board-appearance-panel>`,
                true,
            ),
            // The appearance panel replaces the old layers panel.
            ...super
                .make_sections()
                .filter(
                    (s) =>
                        (s as HTMLElement).getAttribute?.("name") != "layers",
                ),
        ];
    }

    override make_viewer_element(): KCBoardViewerElement {
        return html`<kc-board-viewer></kc-board-viewer>` as KCBoardViewerElement;
    }

    override make_activities() {
        return [
            // Layers
            html`<kc-ui-activity slot="activities" name="Layers" icon="layers">
                <kc-board-layers-panel></kc-board-layers-panel>
            </kc-ui-activity>`,
            // Objects
            html`<kc-ui-activity
                slot="activities"
                name="Objects"
                icon="category">
                <kc-board-objects-panel></kc-board-objects-panel>
            </kc-ui-activity>`,
            // Footprints
            html`<kc-ui-activity
                slot="activities"
                name="Footprints"
                icon="memory">
                <kc-board-footprints-panel></kc-board-footprints-panel>
            </kc-ui-activity>`,
            // Nets
            html`<kc-ui-activity slot="activities" name="Nets" icon="hub">
                <kc-board-nets-panel></kc-board-nets-panel>
            </kc-ui-activity>`,
            // Properties
            html`<kc-ui-activity
                slot="activities"
                name="Properties"
                icon="list">
                <kc-board-properties-panel></kc-board-properties-panel>
            </kc-ui-activity>`,
            // Board info
            html`<kc-ui-activity
                slot="activities"
                name="Board info"
                icon="info">
                <kc-board-info-panel></kc-board-info-panel>
            </kc-ui-activity>`,
        ];
    }
}

window.customElements.define("kc-board-app", KCBoardAppElement);
