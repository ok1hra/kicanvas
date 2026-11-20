/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { attribute, css, html } from "../base/web-components";
import { KCUIElement } from "./element";

/**
 * Compact colors used by floating panels, modeled on KiCad's dock panels
 * (Appearance, Hierarchy navigator). Also re-maps the kc-ui panel/list
 * variables so that regular panels placed inside of a floating section blend
 * in.
 */
const floating_vars = css`
    :host {
        --fp-bg: rgba(40, 40, 42, 0.97);
        --fp-fg: #e4e4e4;
        --fp-muted: #9a9a9a;
        --fp-border: #575757;
        --fp-header-bg: #353537;
        --fp-section-bg: #2e2e30;
        --fp-section-head-bg: #3b3b3d;
        --fp-hover-bg: #48484b;
        --fp-selected-bg: #2f5d8a;
        --fp-selected-fg: #ffffff;

        --panel-bg: transparent;
        --panel-fg: var(--fp-fg);
        --panel-title-display: none;
        --panel-subtitle-bg: var(--fp-section-head-bg);
        --panel-subtitle-fg: var(--fp-fg);
        --list-item-bg: transparent;
        --list-item-fg: var(--fp-fg);
        --list-item-hover-bg: var(--fp-hover-bg);
        --list-item-hover-fg: var(--fp-fg);
        --list-item-active-bg: var(--fp-selected-bg);
        --list-item-active-fg: var(--fp-selected-fg);
        --list-item-disabled-bg: transparent;
        --list-item-disabled-fg: var(--fp-muted);
        --input-bg: #222224;
        --input-fg: var(--fp-fg);
        --input-border: 1px solid var(--fp-border);
        --scrollbar-bg: transparent;
        --scrollbar-fg: #5c5c60;
        --scrollbar-hover-fg: #7a7a80;
    }
`;

function load_state<T>(key: string | undefined): Partial<T> {
    if (!key) {
        return {};
    }
    try {
        return JSON.parse(window.localStorage.getItem(key) ?? "{}");
    } catch {
        return {};
    }
}

function save_state(key: string | undefined, value: object) {
    if (!key) {
        return;
    }
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage can be unavailable (private mode, blocked site data).
    }
}

/**
 * Saved position: the distance from the left edge, or for panels anchored
 * to the right, from the right edge, so they stay in their corner when the
 * viewer is resized.
 */
type PanelState = {
    left?: number;
    right?: number;
    top: number;
    collapsed: boolean;
};

/**
 * kc-ui-floating-panel is a small, draggable menu that floats over a viewer.
 *
 * It's positioned relative to its offset parent, starts in the top left or
 * top right corner (see `anchor`) and can be moved by dragging its header.
 * Its contents are usually kc-ui-floating-section elements.
 */
export class KCUIFloatingPanelElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        floating_vars,
        css`
            :host {
                position: absolute;
                z-index: 10;
                top: 8px;
                left: 8px;
                width: var(--floating-panel-width, 240px);
                max-height: calc(100% - 16px);
                display: flex;
                flex-direction: column;
                font-size: 12px;
                line-height: 1.35;
                color: var(--fp-fg);
                background: var(--fp-bg);
                border: 1px solid var(--fp-border);
                border-radius: 4px;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
                user-select: none;
            }

            :host([anchor="right"]) {
                left: auto;
                right: 8px;
            }

            header {
                flex: 0 0 auto;
                display: flex;
                align-items: center;
                gap: 6px;
                height: 22px;
                padding: 0 3px 0 4px;
                background: var(--fp-header-bg);
                border-bottom: 1px solid var(--fp-border);
                border-radius: 4px 4px 0 0;
                cursor: move;
                touch-action: none;
            }

            :host([collapsed]) header {
                border-bottom: none;
                border-radius: 4px;
            }

            .grip {
                flex: 0 0 auto;
                width: 8px;
                height: 12px;
                background-image: radial-gradient(
                    var(--fp-muted) 1px,
                    transparent 1.3px
                );
                background-size: 4px 4px;
            }

            .heading {
                flex: 1;
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            button {
                all: unset;
                flex: 0 0 auto;
                width: 18px;
                height: 18px;
                display: grid;
                place-items: center;
                border-radius: 3px;
                cursor: pointer;
                color: var(--fp-muted);
            }

            button:hover {
                background: var(--fp-hover-bg);
                color: var(--fp-fg);
            }

            /* Points up when open (collapse) and down when collapsed
               (expand). */
            button .chevron {
                width: 6px;
                height: 6px;
                border-right: 1.5px solid currentColor;
                border-bottom: 1.5px solid currentColor;
                transform: translateY(1px) rotate(-135deg);
            }

            :host([collapsed]) button .chevron {
                transform: translateY(-1px) rotate(45deg);
            }

            .sections {
                flex: 1 1 auto;
                min-height: 0;
                overflow-x: hidden;
                overflow-y: auto;
                padding: 4px;
                display: flex;
                flex-direction: column;
                gap: 3px;
            }

            :host([collapsed]) .sections {
                display: none;
            }
        `,
    ];

    /** Text shown in the panel's header. */
    @attribute({ type: String })
    heading: string;

    /** Which top corner the panel starts in: "left" (default) or "right". */
    @attribute({ type: String })
    anchor: string;

    /** Whether only the header is shown. */
    @attribute({ type: Boolean })
    collapsed: boolean;

    /** If set, position and collapsed state are remembered in localStorage. */
    @attribute({ type: String })
    storage_key: string;

    #resize_observer?: ResizeObserver;

    get #state_key() {
        return this.storage_key
            ? `kc:floating-panel2:${this.storage_key}`
            : undefined;
    }

    get #right_anchored() {
        return this.anchor == "right";
    }

    override connectedCallback() {
        super.connectedCallback();

        // Only the position is restored; whether the panel starts collapsed
        // is up to whoever creates it.
        const { top, left, right } = load_state<PanelState>(this.#state_key);
        if (top !== undefined) {
            // Wait for layout so the parent's size is known.
            window.requestAnimationFrame(() => {
                if (right !== undefined) {
                    const width = this.#parent?.clientWidth ?? 0;
                    this.move_to(width - this.offsetWidth - right, top);
                } else if (left !== undefined) {
                    this.move_to(left, top);
                }
            });
        }
    }

    override disconnectedCallback() {
        super.disconnectedCallback();
        this.#resize_observer?.disconnect();
    }

    override initialContentCallback() {
        const header = this.renderRoot.querySelector("header")!;
        const button = this.renderRoot.querySelector("button")!;

        button.addEventListener("click", (e) => {
            e.stopPropagation();
            this.collapsed = !this.collapsed;
            this.#save();
        });

        header.addEventListener("dblclick", (e) => {
            if (e.target != button) {
                this.collapsed = !this.collapsed;
                this.#save();
            }
        });

        header.addEventListener("pointerdown", (e) => {
            if (e.button != 0 || (e.target as Element).closest("button")) {
                return;
            }
            e.preventDefault();

            const start = this.#position();
            const start_x = e.clientX;
            const start_y = e.clientY;

            header.setPointerCapture(e.pointerId);

            const move = (e: PointerEvent) => {
                this.move_to(
                    start.left + e.clientX - start_x,
                    start.top + e.clientY - start_y,
                );
            };

            const up = () => {
                header.removeEventListener("pointermove", move);
                header.removeEventListener("pointerup", up);
                header.removeEventListener("pointercancel", up);
                this.#save();
            };

            header.addEventListener("pointermove", move);
            header.addEventListener("pointerup", up);
            header.addEventListener("pointercancel", up);
        });

        // Keep the panel inside of its container when the container shrinks.
        const parent = this.#parent;
        if (parent) {
            this.#resize_observer = new ResizeObserver(() => {
                if (this.style.top) {
                    const { left, top } = this.#position();
                    this.move_to(left, top);
                }
            });
            this.#resize_observer.observe(parent);
        }
    }

    get #parent() {
        return (this.offsetParent ?? this.parentElement) as
            | HTMLElement
            | undefined;
    }

    #position() {
        return { left: this.offsetLeft, top: this.offsetTop };
    }

    /**
     * Moves the panel, keeping it within its offset parent. Panels anchored
     * to the right keep their distance from the right edge when the parent
     * is resized.
     */
    move_to(left: number, top: number) {
        const parent = this.#parent;
        const parent_width = parent?.clientWidth ?? 0;
        if (parent) {
            const max_left = parent_width - this.offsetWidth;
            const max_top = parent.clientHeight - 24;
            left = Math.max(0, Math.min(left, max_left));
            top = Math.max(0, Math.min(top, max_top));
        }
        this.style.top = `${top}px`;
        if (this.#right_anchored && parent) {
            this.style.right = `${parent_width - left - this.offsetWidth}px`;
            this.style.left = "auto";
        } else {
            this.style.left = `${left}px`;
            this.style.right = "auto";
        }
    }

    #save() {
        const state: Partial<PanelState> = { collapsed: this.collapsed };
        if (this.style.top) {
            const { left, top } = this.#position();
            state.top = top;
            const parent = this.#parent;
            if (this.#right_anchored && parent) {
                state.right = parent.clientWidth - left - this.offsetWidth;
            } else {
                state.left = left;
            }
        }
        save_state(this.#state_key, state);
    }

    /** Opens the named section (and the panel itself, if collapsed). */
    open_section(name: string) {
        const section = this.querySelector<KCUIFloatingSectionElement>(
            `kc-ui-floating-section[name="${name}"]`,
        );
        if (section) {
            this.collapsed = false;
            section.open = true;
            section.scrollIntoView({ block: "nearest" });
        }
    }

    override render() {
        return html`<header title="Drag to move, double-click to collapse">
                <span class="grip"></span>
                <span class="heading">${this.heading}</span>
                <button type="button" title="Collapse / expand">
                    <span class="chevron"></span>
                </button>
            </header>
            <div class="sections"><slot></slot></div>`;
    }
}

window.customElements.define("kc-ui-floating-panel", KCUIFloatingPanelElement);

/**
 * kc-ui-floating-section is a collapsible section of a floating panel: a
 * small titled rectangle that expands to show its content.
 */
export class KCUIFloatingSectionElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                display: block;
                flex: 0 0 auto;
                background: var(--fp-section-bg);
                border: 1px solid var(--fp-border);
                border-radius: 3px;
            }

            .head {
                display: flex;
                align-items: center;
                gap: 6px;
                height: 20px;
                padding: 0 6px;
                background: var(--fp-section-head-bg);
                border-radius: 3px;
                cursor: pointer;
            }

            .head:hover {
                background: var(--fp-hover-bg);
            }

            :host([open]) .head {
                border-bottom: 1px solid var(--fp-border);
                border-radius: 3px 3px 0 0;
            }

            .caret {
                flex: 0 0 auto;
                width: 0;
                height: 0;
                border-left: 4px solid var(--fp-muted);
                border-top: 3.5px solid transparent;
                border-bottom: 3.5px solid transparent;
                transition: transform 0.1s ease;
            }

            :host([open]) .caret {
                transform: rotate(90deg);
            }

            .heading {
                flex: 1;
                font-weight: 500;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .body {
                display: none;
                max-height: var(--floating-section-max-height, 45vh);
                overflow: auto;
                user-select: text;
            }

            :host([open]) .body {
                display: block;
            }
        `,
    ];

    static toggle_event = "kc-ui-floating-section:toggle";

    /** Identifier used by KCUIFloatingPanelElement.open_section() */
    @attribute({ type: String })
    name: string;

    @attribute({ type: String })
    heading: string;

    @attribute({ type: Boolean })
    open: boolean;

    override initialContentCallback() {
        this.renderRoot
            .querySelector(".head")!
            .addEventListener("click", (e) => {
                if ((e.target as Element).closest("[slot=actions]")) {
                    return;
                }
                this.open = !this.open;
                this.dispatchEvent(
                    new CustomEvent(KCUIFloatingSectionElement.toggle_event, {
                        detail: this,
                        bubbles: true,
                        composed: true,
                    }),
                );
            });
    }

    override render() {
        return html`<div class="head">
                <span class="caret"></span>
                <span class="heading">${this.heading}</span>
                <slot name="actions"></slot>
            </div>
            <div class="body"><slot></slot></div>`;
    }
}

window.customElements.define(
    "kc-ui-floating-section",
    KCUIFloatingSectionElement,
);
