/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { attribute, css, html } from "../base/web-components";
import { KCUIElement } from "./element";

/**
 * kc-ui-divider is a draggable vertical bar between two panes in a flex row.
 *
 * Dragging it sets the width of the pane before it as a percentage of the
 * parent; the pane after it should grow to fill the rest. Double-clicking
 * resets the split to 50/50.
 */
export class KCUIDividerElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                position: relative;
                z-index: 20;
                flex: 0 0 6px;
                cursor: col-resize;
                background: #3a3a3c;
                border-left: 1px solid #222;
                border-right: 1px solid #222;
                touch-action: none;
                user-select: none;
            }

            /* Wider, invisible grab area. */
            :host::before {
                content: "";
                position: absolute;
                top: 0;
                bottom: 0;
                left: -5px;
                right: -5px;
            }

            .grip {
                position: absolute;
                left: 50%;
                top: 50%;
                width: 4px;
                height: 34px;
                transform: translate(-50%, -50%);
                border-radius: 2px;
                background-image: radial-gradient(
                    #b8b8b8 1px,
                    transparent 1.4px
                );
                background-size: 4px 6px;
                background-position: center;
                pointer-events: none;
            }

            :host(:hover),
            :host(.active) {
                background: #2f5d8a;
            }

            :host(:hover) .grip,
            :host(.active) .grip {
                background-image: radial-gradient(
                    #ffffff 1px,
                    transparent 1.4px
                );
            }
        `,
    ];

    static resize_event = "kc-ui-divider:resize";

    /** If set, the split ratio is remembered in localStorage. */
    @attribute({ type: String })
    storage_key: string;

    /** Smallest allowed ratio for either pane. */
    min_ratio = 0.1;

    get #key() {
        return this.storage_key ? `kc:divider:${this.storage_key}` : undefined;
    }

    override connectedCallback() {
        super.connectedCallback();
        this.title = "Drag to resize, double-click to reset";

        let ratio = 0.5;
        try {
            const saved = Number(
                this.#key ? window.localStorage.getItem(this.#key) : NaN,
            );
            if (Number.isFinite(saved) && saved > 0) {
                ratio = saved;
            }
        } catch {
            // Storage unavailable.
        }
        this.ratio = ratio;
    }

    get ratio(): number {
        const basis = (this.previousElementSibling as HTMLElement | null)?.style
            .flexBasis;
        return basis ? parseFloat(basis) / 100 : 0.5;
    }

    set ratio(value: number) {
        const prev = this.previousElementSibling as HTMLElement | null;
        if (!prev) {
            return;
        }
        value = Math.min(1 - this.min_ratio, Math.max(this.min_ratio, value));
        prev.style.flexBasis = `${(value * 100).toFixed(3)}%`;
        this.dispatchEvent(
            new CustomEvent(KCUIDividerElement.resize_event, {
                detail: value,
                bubbles: true,
                composed: true,
            }),
        );
    }

    #save() {
        try {
            if (this.#key) {
                window.localStorage.setItem(this.#key, `${this.ratio}`);
            }
        } catch {
            // Storage unavailable.
        }
    }

    override initialContentCallback() {
        this.addEventListener("dblclick", () => {
            this.ratio = 0.5;
            this.#save();
        });

        this.addEventListener("pointerdown", (e) => {
            if (e.button != 0 || !this.parentElement) {
                return;
            }
            e.preventDefault();
            this.setPointerCapture(e.pointerId);
            this.classList.add("active");
            document.body.style.cursor = "col-resize";

            const rect = this.parentElement.getBoundingClientRect();

            const move = (e: PointerEvent) => {
                this.ratio = (e.clientX - rect.left) / rect.width;
            };

            const up = () => {
                this.removeEventListener("pointermove", move);
                this.removeEventListener("pointerup", up);
                this.removeEventListener("pointercancel", up);
                this.classList.remove("active");
                document.body.style.cursor = "";
                this.#save();
            };

            this.addEventListener("pointermove", move);
            this.addEventListener("pointerup", up);
            this.addEventListener("pointercancel", up);
        });
    }

    override render() {
        return html`<div class="grip"></div>`;
    }
}

window.customElements.define("kc-ui-divider", KCUIDividerElement);
