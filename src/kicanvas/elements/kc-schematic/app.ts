/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { html } from "../../../base/web-components";
import type { KCUIButtonElement } from "../../../kc-ui";
import { KCViewerAppElement } from "../common/app";
import { KCSchematicViewerElement } from "./viewer";

// Import dependent elements so they're registered before use.
import "./hierarchy-panel";
import "./info-panel";
import "./properties-panel";
import "./symbols-panel";
import "./viewer";
import type { ProjectPage } from "../../project";
import { KicadSch } from "../../../kicad";
import { SchematicSheet } from "../../../kicad/schematic";
import { KiCanvasActivateEvent } from "../../../viewers/base/events";

/**
 * Internal "parent" element for KiCanvas's schematic viewer. Handles
 * setting up the schematic viewer as well as interface controls. It's
 * basically KiCanvas's version of EESchema.
 */
export class KCSchematicAppElement extends KCViewerAppElement<KCSchematicViewerElement> {
    override on_viewer_select(item?: unknown, previous?: unknown) {
        // In floating mode, sheets are opened by double clicking (see
        // KiCanvasActivateEvent) and the part info card shows properties.
        if (this.floating) {
            return;
        }

        // Only handle double-selecting/double-clicking on items.
        if (!item || item != previous) {
            return;
        }

        // If it's a sheet instance, switch over to the new sheet.
        if (item instanceof SchematicSheet) {
            this.#open_sheet(item);
            return;
        }

        // Otherwise, selecting the same item twice will show the
        // properties panel.
        this.change_activity("properties");
    }

    #open_sheet(sheet: SchematicSheet) {
        this.project.set_active_page(
            `${sheet.sheetfile}:${sheet.path}/${sheet.uuid}`,
        );
    }

    /** The parent sheet of the shown sheet, if it isn't the root. */
    get parent_page(): ProjectPage | undefined {
        const page = this.current_page;
        if (!page?.sheet_path) {
            return undefined;
        }
        const parts = page.sheet_path.split("/").filter(Boolean);
        if (parts.length < 2) {
            return undefined;
        }
        return this.project.page_by_sheet_path(
            `/${parts.slice(0, -1).join("/")}`,
        );
    }

    /** Shows the parent sheet, like KiCad's "Leave Sheet". */
    leave_sheet() {
        const parent = this.parent_page;
        if (parent) {
            this.project.set_active_page(parent);
        }
    }

    override initialContentCallback() {
        super.initialContentCallback();

        // Double clicking a sheet opens it. Unlike a click, it doesn't
        // change the selection or highlighted net.
        this.addDisposable(
            this.viewer.addEventListener(KiCanvasActivateEvent.type, (e) => {
                if (e.detail.item instanceof SchematicSheet) {
                    this.#open_sheet(e.detail.item);
                }
            }),
        );

        // The "up" button is only useful below the root sheet.
        this.addEventListener(KCViewerAppElement.page_loaded_event, () => {
            const up = this.button("leave_sheet");
            if (up) {
                up.disabled = !this.parent_page;
            }
        });
    }

    override can_load(src: ProjectPage): boolean {
        return src.document instanceof KicadSch;
    }

    protected override initial_page() {
        const active = this.project.active_page;
        if (active && this.can_load(active)) {
            return active;
        }
        return this.project.root_schematic_page;
    }

    protected override get menu_heading() {
        return "Schematic";
    }

    /** "dark" (the default) or "light" */
    static #theme_key = "kc:schematic-theme";

    #dark_mode_from_storage() {
        try {
            return (
                window.localStorage.getItem(KCSchematicAppElement.#theme_key) !=
                "light"
            );
        } catch {
            return true;
        }
    }

    protected override make_toolbar_buttons() {
        const dark = this.#dark_mode_from_storage();
        if (dark) {
            // Applied once the viewer element exists.
            window.queueMicrotask(() => this.#set_dark(true));
        }
        const up = this.toolbar_button(
            "leave_sheet",
            "Up to the parent sheet (Alt+Backspace)",
            "arrow_upward",
        );
        up.disabled = true;
        return [
            up,
            this.toolbar_button("dark_mode", "Dark mode", "dark_mode", dark),
        ];
    }

    #set_dark(dark: boolean) {
        const viewer_elm = this.renderRoot.querySelector(
            "kc-schematic-viewer",
        ) as KCSchematicViewerElement | null;
        if (viewer_elm) {
            viewer_elm.dark = dark;
        }
        try {
            window.localStorage.setItem(
                KCSchematicAppElement.#theme_key,
                dark ? "dark" : "light",
            );
        } catch {
            // Storage unavailable.
        }
    }

    protected override on_button(name: string, button: KCUIButtonElement) {
        if (name == "dark_mode") {
            button.selected = !button.selected;
            this.#set_dark(button.selected);
            return true;
        }
        if (name == "leave_sheet") {
            this.leave_sheet();
            return true;
        }
        return false;
    }

    protected override make_sections() {
        return [
            this.section(
                "hierarchy",
                "Hierarchy",
                html`<kc-schematic-hierarchy-panel></kc-schematic-hierarchy-panel>`,
                true,
            ),
            ...super.make_sections(),
        ];
    }

    override make_viewer_element(): KCSchematicViewerElement {
        return html`<kc-schematic-viewer></kc-schematic-viewer>` as KCSchematicViewerElement;
    }

    override make_activities() {
        return [
            // Symbols
            html`<kc-ui-activity
                slot="activities"
                name="Symbols"
                icon="interests">
                <kc-schematic-symbols-panel></kc-schematic-symbols-panel>
            </kc-ui-activity>`,

            // Schematic item properties
            html`<kc-ui-activity
                slot="activities"
                name="Properties"
                icon="list">
                <kc-schematic-properties-panel></kc-schematic-properties-panel>
            </kc-ui-activity>`,

            // Schematic info
            html`<kc-ui-activity slot="activities" name="Info" icon="info">
                <kc-schematic-info-panel></kc-schematic-info-panel>
            </kc-ui-activity>`,
        ];
    }
}

window.customElements.define("kc-schematic-app", KCSchematicAppElement);
