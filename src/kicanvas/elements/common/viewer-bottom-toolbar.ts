/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { attribute, css, html } from "../../../base/web-components";
import { KCUIElement, type KCUIButtonElement } from "../../../kc-ui";
import {
    KiCanvasMouseMoveEvent,
    KiCanvasSelectEvent,
} from "../../../viewers/base/events";
import type { Viewer } from "../../../viewers/base/viewer";

export class KCViewerBottomToolbarElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host([mode="floating"]) output {
                padding: 0.15em 0.5em;
                font-size: 11px;
                font-variant-numeric: tabular-nums;
                opacity: 0.85;
            }

            output {
                width: unset;
                margin: unset;
                padding: 0.5em;
                color: var(--button-toolbar-fg);
                background: var(--button-toolbar-bg);
                border: 1px solid var(--button-toolbar-bg);
                border-radius: 0.25em;
                font-weight: 300;
                font-size: 0.9em;
                box-shadow: var(--input-hover-shadow);
                user-select: none;
            }
        `,
    ];

    /**
     * "floating": a compact toolbar for the split workspace, with a "fit to
     * design" button and buttons given as children (slot="left"/"right").
     */
    @attribute({ type: String })
    mode: string;

    /** Show the mouse position (floating mode only; always shown otherwise) */
    @attribute({ type: Boolean })
    coordinates: boolean;

    viewer: Viewer;
    #position_elm: HTMLOutputElement;
    #zoom_to_page_btn: KCUIButtonElement;
    #zoom_to_selection_btn: KCUIButtonElement;

    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;

            super.connectedCallback();

            this.addDisposable(
                this.viewer.addEventListener(
                    KiCanvasMouseMoveEvent.type,
                    () => {
                        this.update_position();
                    },
                ),
            );
            if (this.mode == "floating") {
                this.#fit_btn.addEventListener("click", (e) => {
                    e.preventDefault();
                    (
                        this.viewer as Viewer & { zoom_to_fit(): void }
                    ).zoom_to_fit();
                });
                return;
            }

            this.addDisposable(
                this.viewer.addEventListener(KiCanvasSelectEvent.type, (e) => {
                    this.#zoom_to_selection_btn.disabled = e.detail.item
                        ? false
                        : true;
                }),
            );

            this.#zoom_to_page_btn.addEventListener("click", (e) => {
                e.preventDefault();
                this.viewer.zoom_to_page();
            });
            this.#zoom_to_selection_btn.addEventListener("click", (e) => {
                e.preventDefault();
                this.viewer.zoom_to_selection();
            });
        })();
    }

    #fit_btn: KCUIButtonElement;

    private update_position() {
        const pos = this.viewer?.mouse_position;
        if (!pos) {
            return;
        }
        this.#position_elm.value =
            this.mode == "floating"
                ? `X ${pos.x.toFixed(2)}  Y ${pos.y.toFixed(2)} mm`
                : `${pos.x.toFixed(2)}, ${pos.y.toFixed(2)} mm`;
    }

    override render() {
        if (this.mode == "floating") {
            this.#position_elm = html`<output
                slot="left"
                class="toolbar"></output>` as HTMLOutputElement;
            this.#fit_btn = html`<kc-ui-button
                slot="right"
                variant="toolbar"
                name="zoom_to_fit"
                title="Fit to design"
                icon="fit_screen">
            </kc-ui-button>` as KCUIButtonElement;
            this.update_position();

            return html`<kc-ui-floating-toolbar location="bottom">
                <slot name="left" slot="left"></slot>
                ${this.coordinates ? this.#position_elm : null}
                <slot name="right" slot="right"></slot>
                ${this.#fit_btn}
            </kc-ui-floating-toolbar>`;
        }

        this.#position_elm = html`<output
            slot="left"
            class="toolbar"></output>` as HTMLOutputElement;

        this.#zoom_to_page_btn = html`<kc-ui-button
            slot="right"
            variant="toolbar"
            name="zoom_to_page"
            title="zoom to page"
            icon="svg:zoom_page">
        </kc-ui-button>` as KCUIButtonElement;

        this.#zoom_to_selection_btn = html` <kc-ui-button
            slot="right"
            variant="toolbar"
            name="zoom_to_selection"
            title="zoom to selection"
            icon="svg:zoom_footprint"
            disabled>
        </kc-ui-button>` as KCUIButtonElement;

        this.update_position();

        return html`<kc-ui-floating-toolbar location="bottom">
            ${this.#position_elm} ${this.#zoom_to_selection_btn}
            ${this.#zoom_to_page_btn}
        </kc-ui-floating-toolbar>`;
    }
}

window.customElements.define(
    "kc-viewer-bottom-toolbar",
    KCViewerBottomToolbarElement,
);
