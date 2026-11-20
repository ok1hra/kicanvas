/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { attribute, css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import {
    datasheet_href,
    factorify_href,
    key_fields,
    type PartInfo,
} from "../../part-info";

/**
 * A small card with a part's key metadata (ID, datasheet, part_value),
 * shown next to where the part was clicked. "Show all" enlarges it to list
 * every field.
 */
export class KCPartInfoElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                position: absolute;
                z-index: 30;
                display: none;
                width: 260px;
                max-height: calc(100% - 16px);
                flex-direction: column;
                font-size: 12px;
                line-height: 1.4;
                color: #e4e4e4;
                background: rgba(40, 40, 42, 0.97);
                border: 1px solid #575757;
                border-radius: 4px;
                box-shadow: 0 3px 14px rgba(0, 0, 0, 0.45);
            }

            :host([open]) {
                display: flex;
            }

            :host([expanded]) {
                width: 400px;
            }

            header {
                display: flex;
                align-items: baseline;
                gap: 8px;
                padding: 5px 4px 5px 8px;
                background: #353537;
                border-bottom: 1px solid #575757;
                border-radius: 4px 4px 0 0;
            }

            .ref {
                font-weight: 700;
                font-size: 13px;
            }

            .value {
                flex: 1;
                color: #b9b9b9;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            button {
                all: unset;
                cursor: pointer;
                border-radius: 3px;
            }

            button.close {
                align-self: center;
                width: 18px;
                height: 18px;
                display: grid;
                place-items: center;
                color: #9a9a9a;
                font-size: 15px;
                line-height: 1;
            }

            button.close:hover {
                background: #48484b;
                color: #fff;
            }

            .body {
                overflow: auto;
                padding: 4px 0;
                user-select: text;
            }

            .fields {
                display: grid;
                grid-template-columns: max-content 1fr;
                column-gap: 10px;
                row-gap: 2px;
                padding: 0 8px;
            }

            .name {
                font-weight: 500;
                color: #9a9a9a;
                white-space: nowrap;
            }

            .name.key {
                color: #cfcfcf;
            }

            .val {
                word-break: break-word;
            }

            .val.empty {
                color: #777;
            }

            hr {
                grid-column: 1 / -1;
                width: 100%;
                border: none;
                border-top: 1px solid #444;
                margin: 3px 0;
            }

            a {
                color: #7fb6ff;
            }

            footer {
                display: flex;
                justify-content: flex-end;
                padding: 4px 6px 6px;
                border-top: 1px solid #444;
            }

            button.toggle {
                padding: 2px 8px;
                border: 1px solid #575757;
                background: #3b3b3d;
            }

            button.toggle:hover {
                background: #48484b;
            }
        `,
    ];

    /** Whether all fields are shown. */
    @attribute({ type: Boolean })
    expanded: boolean;

    @attribute({ type: Boolean })
    open: boolean;

    #info?: PartInfo;
    #anchor = { x: 0, y: 0 };

    get info() {
        return this.#info;
    }

    /**
     * Shows a part's info.
     *
     * @param anchor - the point to show it next to, relative to the offset
     *     parent (e.g. where the part was clicked).
     */
    show(info: PartInfo, anchor?: { x: number; y: number }) {
        const same_part = this.open && this.#info?.reference == info.reference;
        this.#info = info;
        if (anchor && !same_part) {
            this.#anchor = anchor;
        }
        if (!same_part) {
            this.expanded = false;
        }
        this.open = true;
        this.update();
    }

    static hidden_event = "kicanvas:part-info-hidden";

    hide() {
        const was_open = this.open;
        this.open = false;
        this.#info = undefined;
        if (was_open) {
            this.dispatchEvent(
                new CustomEvent(KCPartInfoElement.hidden_event, {
                    bubbles: true,
                    composed: true,
                }),
            );
        }
    }

    override initialContentCallback() {
        this.renderRoot.addEventListener("click", (e) => {
            const button = (e.target as Element).closest("button");
            if (button?.classList.contains("close")) {
                this.hide();
            } else if (button?.classList.contains("toggle")) {
                this.expanded = !this.expanded;
                this.update();
            }
        });

        const on_key = (e: KeyboardEvent) => {
            if (e.key == "Escape" && this.open) {
                this.hide();
            }
        };
        window.addEventListener("keydown", on_key);
        this.addDisposable({
            dispose: () => window.removeEventListener("keydown", on_key),
        });
    }

    override renderedCallback() {
        if (this.open) {
            this.#position();
        }
    }

    /** Places the card next to the anchor, inside the offset parent. */
    #position() {
        const parent = this.offsetParent as HTMLElement | null;
        if (!parent) {
            return;
        }
        const margin = 8;
        let x = this.#anchor.x + 16;
        let y = this.#anchor.y + 16;
        const w = this.offsetWidth;
        const h = this.offsetHeight;

        // Flip to the other side of the anchor if there's no room.
        if (x + w > parent.clientWidth - margin) {
            x = this.#anchor.x - 16 - w;
        }
        if (y + h > parent.clientHeight - margin) {
            y = this.#anchor.y - 16 - h;
        }

        x = Math.max(margin, Math.min(x, parent.clientWidth - w - margin));
        y = Math.max(margin, Math.min(y, parent.clientHeight - h - margin));
        this.style.left = `${x}px`;
        this.style.top = `${y}px`;
    }

    #value(name: string, value: string | undefined) {
        const lower = name.toLowerCase();
        const href =
            lower == "datasheet"
                ? datasheet_href(value)
                : lower == "id"
                  ? factorify_href(value)
                  : undefined;
        if (href) {
            return html`<span class="val"
                ><a href="${href}" target="_blank" rel="noopener noreferrer"
                    >${value}</a
                ></span
            >`;
        }
        if (!value || value == "~") {
            return html`<span class="val empty">—</span>`;
        }
        return html`<span class="val">${value}</span>`;
    }

    #field(name: string, value: string | undefined, key = false) {
        return html`<span class="name ${key ? "key" : ""}">${name}</span>
            ${this.#value(name, value)}`;
    }

    override render() {
        const info = this.#info;
        if (!info) {
            return html``;
        }

        const key_rows = key_fields.map((name) =>
            this.#field(name, info.get(name), true),
        );

        const other_rows = this.expanded
            ? info.fields
                  .filter(
                      (f) =>
                          // Already shown: in the header and the key rows.
                          f.name != "Reference" &&
                          !key_fields.some(
                              (k) => k.toLowerCase() == f.name.toLowerCase(),
                          ),
                  )
                  .map((f) => this.#field(f.name, f.value))
            : [];

        return html`<header>
                <span class="ref">${info.reference}</span>
                <span class="value" title="${info.value}">${info.value}</span>
                <button class="close" type="button" title="Close (Esc)">
                    ×
                </button>
            </header>
            <div class="body">
                <div class="fields">
                    ${key_rows} ${other_rows.length ? html`<hr />` : null}
                    ${other_rows}
                </div>
            </div>
            <footer>
                <button class="toggle" type="button">
                    ${this.expanded
                        ? "Show less"
                        : `Show all (${info.fields.length})`}
                </button>
            </footer>`;
    }
}

window.customElements.define("kc-part-info", KCPartInfoElement);
