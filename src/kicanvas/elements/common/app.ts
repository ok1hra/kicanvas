/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { DeferredPromise } from "../../../base/async";
import { delegate, listen } from "../../../base/events";
import { length } from "../../../base/iterator";
import {
    attribute,
    html,
    type ElementOrFragment,
} from "../../../base/web-components";
import { parseFlagAttribute } from "../../../base/web-components/flag-attribute";
import {
    KCUIActivitySideBarElement,
    KCUIButtonElement,
    KCUIElement,
    KCUIFloatingPanelElement,
} from "../../../kc-ui";
import { KiCanvasSelectEvent } from "../../../viewers/base/events";
import type { Viewer } from "../../../viewers/base/viewer";
import type { Project, ProjectPage } from "../../project";
import { KCBoardViewerElement } from "../kc-board/viewer";

// import dependent elements so they're registered before use.
import "./help-panel";
import "./preferences-panel";
import "./project-panel";
import "./viewer-bottom-toolbar";

interface ViewerElement extends HTMLElement {
    viewer: Viewer;
    load(src: ProjectPage): Promise<void>;
    disableinteraction: boolean;
}

/**
 * Common base class for the schematic, board, etc. apps.
 */
export abstract class KCViewerAppElement<
    ViewerElementT extends ViewerElement,
> extends KCUIElement {
    #viewer_elm: ViewerElementT;
    #activity_bar: KCUIActivitySideBarElement | null;
    #floating_panel: KCUIFloatingPanelElement | null = null;
    #current_page?: ProjectPage;

    project: Project;
    viewerReady: DeferredPromise<boolean> = new DeferredPromise<boolean>();

    constructor() {
        super();
        this.provideLazyContext("viewer", () => this.viewer);
    }

    get viewer() {
        return this.#viewer_elm.viewer;
    }

    /**
     * - none: not interactive
     * - basic: pan, zoom & select
     * - full: activity side bar with panels
     * - floating: panels are sections of a small draggable floating menu,
     *   and the app keeps showing its own page when the project's active
     *   page is one it can't show (so that a schematic and a board app can
     *   be shown side by side).
     */
    @attribute({ type: String })
    controls: "none" | "basic" | "full" | "floating";

    @attribute({ type: String })
    controlslist: string;

    @attribute({ type: Boolean })
    sidebarcollapsed: boolean;

    override connectedCallback() {
        this.hidden = true;
        (async () => {
            this.project = await this.requestContext("project");
            await this.project.loaded;
            super.connectedCallback();
        })();
    }

    /** The page currently shown by this app. */
    get current_page() {
        return this.#current_page;
    }

    get floating() {
        return this.controls == "floating";
    }

    /**
     * The page to show initially in floating mode, when the project's
     * active page might be for the other app.
     */
    protected initial_page(): ProjectPage | undefined {
        return this.project.active_page ?? undefined;
    }

    override initialContentCallback() {
        // If the project already has an active page, load it.
        const initial = this.floating
            ? this.initial_page()
            : this.project.active_page;
        if (initial) {
            this.load(initial);
        }

        // Listen for changes to the project's active page and load or hide
        // as needed.
        this.addDisposable(
            listen(this.project, "change", async (e) => {
                const page = this.project.active_page;
                if (page) {
                    if (this.floating && !this.can_load(page)) {
                        // The other app will show it.
                        return;
                    }
                    await this.load(page);
                } else {
                    this.hidden = true;
                }
            }),
        );

        // Handle item selection in the viewers.
        this.addDisposable(
            this.viewer.addEventListener(KiCanvasSelectEvent.type, (e) => {
                this.on_viewer_select(e.detail.item, e.detail.previous);
            }),
        );

        // Handle download button.
        delegate(this.renderRoot, "kc-ui-button", "click", (e) => {
            const target = e.target as KCUIButtonElement;
            switch (target.name) {
                case "download": {
                    const page = this.#current_page ?? this.project.active_page;
                    if (page) {
                        this.project.download(page.filename);
                    }
                    break;
                }
                case "flip_view":
                    this.#viewer_elm.viewer.flip_view();
                    break;
                default:
                    console.warn("Unknown button", e);
            }
        });
    }

    protected abstract on_viewer_select(
        item?: unknown,
        previous?: unknown,
    ): void;

    protected abstract can_load(src: ProjectPage): boolean;

    async load(src: ProjectPage) {
        await this.viewerReady;
        if (this.can_load(src)) {
            this.#current_page = src;
            this.hidden = false;
            await this.#viewer_elm.load(src);
            this.dispatchEvent(
                new CustomEvent(KCViewerAppElement.page_loaded_event, {
                    detail: src,
                    bubbles: true,
                    composed: true,
                }),
            );
        } else if (!this.floating) {
            this.hidden = true;
        }
    }

    /** Fired after the app shows a new page. */
    static page_loaded_event = "kicanvas:app:page-loaded";

    #has_more_than_one_page() {
        return length(this.project.pages()) > 1;
    }

    protected make_pre_activities() {
        const activities = [];

        if (this.#has_more_than_one_page()) {
            activities.push(
                html`<kc-ui-activity
                    slot="activities"
                    name="Project"
                    icon="folder">
                    <kc-project-panel></kc-project-panel>
                </kc-ui-activity>`,
            );
        }

        return activities;
    }

    protected make_post_activities() {
        return [
            // Preferences
            html`<kc-ui-activity
                slot="activities"
                name="Preferences"
                icon="settings"
                button-location="bottom">
                <kc-preferences-panel></kc-preferences-panel>
            </kc-ui-activity>`,

            // Help
            html` <kc-ui-activity
                slot="activities"
                name="Help"
                icon="help"
                button-location="bottom">
                <kc-help-panel></kc-help-panel>
            </kc-ui-activity>`,
        ];
    }

    protected abstract make_activities(): ElementOrFragment[];

    /**
     * Sections of the floating menu used when controls="floating". By
     * default each activity becomes a (closed) section.
     */
    protected make_sections(): ElementOrFragment[] {
        return [...this.make_activities(), ...this.make_post_activities()].map(
            (activity) => this.activity_to_section(activity),
        );
    }

    /** Heading of the floating menu. */
    protected get menu_heading(): string {
        return "";
    }

    /** Which side of the viewer the floating menu starts on. */
    protected get menu_anchor(): "left" | "right" {
        return "left";
    }

    /** Creates a floating menu section. */
    protected section(
        name: string,
        heading: string,
        content: ElementOrFragment,
        open = false,
    ) {
        return html`<kc-ui-floating-section
            name="${name}"
            heading="${heading}"
            open="${open}">
            ${content}
        </kc-ui-floating-section>`;
    }

    /** Moves the content of a kc-ui-activity into a floating section. */
    protected activity_to_section(activity: ElementOrFragment) {
        const elm =
            activity instanceof DocumentFragment
                ? activity.firstElementChild!
                : activity;
        const name = elm.getAttribute("name") ?? "";
        const content = document.createDocumentFragment();
        content.append(...elm.childNodes);
        return this.section(name.toLowerCase(), name, content);
    }

    protected change_activity(name?: string) {
        if (this.#floating_panel && name) {
            this.#floating_panel.open_section(name.toLowerCase());
            return;
        }
        this.#activity_bar?.change_activity(name);
    }

    protected abstract make_viewer_element(): ViewerElementT;

    override render() {
        const controls = this.controls ?? "none";
        const controlslist = parseFlagAttribute(
            this.controlslist ?? "",
            controls == "none"
                ? { fullscreen: false, download: false, flipview: false }
                : { fullscreen: true, download: true, flipview: true },
        );

        this.#viewer_elm = this.make_viewer_element();
        this.#viewer_elm.disableinteraction = controls == "none";

        let resizer = null;

        this.#floating_panel = null;

        if (controls == "floating") {
            this.#activity_bar = null;
            this.#floating_panel = html`<kc-ui-floating-panel
                heading="${this.menu_heading}"
                anchor="${this.menu_anchor}"
                storage-key="${this.localName}">
                ${this.make_sections()}
            </kc-ui-floating-panel>` as KCUIFloatingPanelElement;
        } else if (controls == "full") {
            const pre_activities = this.make_pre_activities();
            const post_activities = this.make_post_activities();
            const activities = this.make_activities();
            this.#activity_bar = html`<kc-ui-activity-side-bar
                collapsed="${this.sidebarcollapsed}">
                ${pre_activities} ${activities} ${post_activities}
            </kc-ui-activity-side-bar>` as KCUIActivitySideBarElement;
            resizer = html`<kc-ui-resizer></kc-ui-resizer>`;
        } else {
            // No activity bar
            this.#activity_bar = null;
        }

        const top_toolbar_buttons = [];
        // Keep the toolbar buttons clear of the floating menu.
        const toolbar_slot =
            controls == "floating" && this.menu_anchor == "right"
                ? "left"
                : "right";

        if (controlslist["download"] && !this.#has_more_than_one_page()) {
            top_toolbar_buttons.push(
                html`<kc-ui-button
                    slot="${toolbar_slot}"
                    name="download"
                    title="download"
                    icon="download"
                    variant="toolbar-alt">
                </kc-ui-button>`,
            );
        }

        if (
            controlslist["flipview"] &&
            this.#viewer_elm instanceof KCBoardViewerElement
        ) {
            top_toolbar_buttons.push(
                html`<kc-ui-button
                    slot="${toolbar_slot}"
                    name="flip_view"
                    title="flip view"
                    icon="flip"
                    variant="toolbar-alt">
                </kc-ui-button>`,
            );
        }

        const top_toolbar = html`<kc-ui-floating-toolbar location="top">
            ${top_toolbar_buttons}
        </kc-ui-floating-toolbar>`;

        let bottom_toolbar = null;
        if (controls != "none") {
            bottom_toolbar = html`<kc-viewer-bottom-toolbar></kc-viewer-bottom-toolbar>`;
        }

        return html`<kc-ui-split-view vertical>
            <kc-ui-view class="grow">
                ${top_toolbar} ${this.#viewer_elm} ${bottom_toolbar}
                ${this.#floating_panel}
            </kc-ui-view>
            ${resizer} ${this.#activity_bar}
        </kc-ui-split-view>`;
    }

    override renderedCallback(): void | undefined {
        window.requestAnimationFrame(() => {
            this.viewerReady.resolve(true);
        });
    }
}
