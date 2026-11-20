/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import type { ChooserItem } from "../../../viewers/base/viewer";

/** Same event as KiCanvasShellElement.hint_event */
const hint_event = "kicanvas:hint";

function set_hint(text: string | null) {
    window.dispatchEvent(
        new CustomEvent(hint_event, { detail: { source: "chooser", text } }),
    );
}

/**
 * A small menu shown where the user clicked, to choose between several
 * things there (e.g. a part and the net of its pad, or the nets of a bus).
 * Looks like the floating panels. Esc or a click elsewhere closes it.
 */
export class KCChooserElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                position: fixed;
                z-index: 1000;
                display: none;
                flex-direction: column;
                min-width: 170px;
                max-width: 340px;
                max-height: min(60vh, 460px);
                font-size: 12px;
                line-height: 1.35;
                color: #e4e4e4;
                background: rgba(40, 40, 42, 0.97);
                border: 1px solid #575757;
                border-radius: 4px;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
                user-select: none;
            }

            :host([open]) {
                display: flex;
            }

            header {
                flex: 0 0 auto;
                display: flex;
                align-items: center;
                height: 22px;
                padding: 0 8px;
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                background: #353537;
                border-bottom: 1px solid #575757;
                border-radius: 4px 4px 0 0;
            }

            ul {
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                list-style: none;
                margin: 0;
                padding: 3px;
            }

            li {
                display: flex;
                align-items: baseline;
                gap: 10px;
                padding: 2px 6px;
                border-radius: 3px;
                cursor: pointer;
                white-space: nowrap;
            }

            li .label {
                overflow: hidden;
                text-overflow: ellipsis;
            }

            li .detail {
                margin-left: auto;
                color: #9a9a9a;
                font-size: 11px;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            li.active {
                background: #2f5d8a;
                color: #fff;
            }

            li.active .detail {
                color: #dcdcdc;
            }

            li.all {
                font-weight: 600;
                border-bottom: 1px solid #4a4a4c;
                border-radius: 3px 3px 0 0;
                margin-bottom: 2px;
            }
        `,
    ];

    #items: ChooserItem[] = [];
    #on_choose: ((value: unknown) => void) | null = null;
    #active = 0;
    #listeners: (() => void)[] = [];

    get open() {
        return this.hasAttribute("open");
    }

    /**
     * Shows the menu at a point (client coordinates). Items with
     * `label == "ALL"` are shown as a heading item.
     */
    show(
        x: number,
        y: number,
        title: string,
        items: ChooserItem[],
        on_choose: (value: unknown) => void,
    ) {
        this.hide();
        this.#items = items;
        this.#on_choose = on_choose;
        this.#active = 0;

        const header = this.renderRoot.querySelector("header")!;
        header.textContent = title;
        const list = this.renderRoot.querySelector("ul")!;
        list.replaceChildren(
            ...items.map((item, i) => {
                const li = html`<li
                    data-i="${i}"
                    title="${item.detail
                        ? `${item.label} (${item.detail})`
                        : item.label}">
                    <span class="label">${item.label}</span>
                    ${item.detail
                        ? html`<span class="detail">${item.detail}</span>`
                        : null}
                </li>` as HTMLElement;
                li.classList.toggle("active", i == 0);
                li.classList.toggle("all", item.label == "ALL");
                return li;
            }),
        );

        this.style.left = `${x + 4}px`;
        this.style.top = `${y + 4}px`;
        this.setAttribute("open", "");

        // Keep it within the window.
        const rect = this.getBoundingClientRect();
        if (rect.right > window.innerWidth - 4) {
            this.style.left = `${Math.max(4, x - rect.width - 4)}px`;
        }
        if (rect.bottom > window.innerHeight - 24) {
            this.style.top = `${Math.max(4, window.innerHeight - rect.height - 24)}px`;
        }

        set_hint("Choose what to select · ↑↓ and Enter · Esc: close");
        this.#listen();
    }

    hide() {
        if (!this.open) {
            return;
        }
        this.removeAttribute("open");
        this.#on_choose = null;
        for (const remove of this.#listeners) {
            remove();
        }
        this.#listeners = [];
        set_hint(null);
    }

    #choose(i: number) {
        const item = this.#items[i];
        const on_choose = this.#on_choose;
        this.hide();
        if (item && on_choose) {
            on_choose(item.value);
        }
    }

    #set_active(i: number) {
        const n = this.#items.length;
        this.#active = (i + n) % n;
        const lis = this.renderRoot.querySelectorAll("li");
        lis.forEach((li, j) =>
            li.classList.toggle("active", j == this.#active),
        );
        lis[this.#active]?.scrollIntoView({ block: "nearest" });
    }

    #listen() {
        const on_key = (e: KeyboardEvent) => {
            const keys: Record<string, () => void> = {
                Escape: () => this.hide(),
                ArrowDown: () => this.#set_active(this.#active + 1),
                ArrowUp: () => this.#set_active(this.#active - 1),
                Enter: () => this.#choose(this.#active),
            };
            const action = keys[e.key];
            if (action) {
                // Esc only closes the menu, it doesn't clear the selection.
                e.preventDefault();
                e.stopImmediatePropagation();
                action();
            }
        };
        const on_pointer = (e: PointerEvent) => {
            if (!e.composedPath().includes(this)) {
                this.hide();
            }
        };
        const on_dismiss = () => this.hide();

        window.addEventListener("keydown", on_key, true);
        window.addEventListener("resize", on_dismiss);
        // Wait for the click that opened the menu to finish.
        const timer = window.setTimeout(() => {
            window.addEventListener("pointerdown", on_pointer, true);
            window.addEventListener("wheel", on_dismiss, true);
        });
        this.#listeners.push(() => {
            window.clearTimeout(timer);
            window.removeEventListener("keydown", on_key, true);
            window.removeEventListener("resize", on_dismiss);
            window.removeEventListener("pointerdown", on_pointer, true);
            window.removeEventListener("wheel", on_dismiss, true);
        });
    }

    override disconnectedCallback() {
        super.disconnectedCallback();
        this.hide();
    }

    override initialContentCallback() {
        const list = this.renderRoot.querySelector("ul")!;
        list.addEventListener("click", (e) => {
            const li = (e.target as Element).closest("li");
            if (li) {
                this.#choose(parseInt(li.getAttribute("data-i") ?? "-1", 10));
            }
        });
        list.addEventListener("pointermove", (e) => {
            const li = (e.target as Element).closest("li");
            const i = parseInt(li?.getAttribute("data-i") ?? "-1", 10);
            if (i >= 0 && i != this.#active) {
                this.#set_active(i);
            }
        });
    }

    override render() {
        return html`<header></header>
            <ul></ul>`;
    }
}

window.customElements.define("kc-chooser", KCChooserElement);
