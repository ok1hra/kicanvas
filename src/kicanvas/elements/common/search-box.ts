/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import { factorify_href } from "../../part-info";
import { search, type SearchItem } from "../../search";

/**
 * Full text search over parts (reference, ID, MPN, value) and nets. The
 * list opens from the second character; picking an item fires
 * KCSearchBoxElement.pick_event with it.
 */
export class KCSearchBoxElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                position: absolute;
                z-index: 28;
                top: 6px;
                width: 280px;
                transform: translateX(-50%);
                font-size: 12px;
            }

            input {
                box-sizing: border-box;
                width: 100%;
                height: 26px;
                padding: 0 10px 0 26px;
                font: inherit;
                color: #e8e8e8;
                background: rgba(40, 40, 42, 0.97)
                    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='%23a0a0a0'><path d='M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'/></svg>")
                    no-repeat 7px center;
                border: 1px solid #5a5a5a;
                border-radius: 13px;
                outline: none;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
            }

            input:focus {
                border-color: #4a86c5;
            }

            ul {
                display: none;
                list-style: none;
                margin: 4px 0 0;
                padding: 3px 0;
                max-height: min(60vh, 420px);
                overflow-y: auto;
                background: rgba(40, 40, 42, 0.98);
                border: 1px solid #5a5a5a;
                border-radius: 4px;
                box-shadow: 0 3px 14px rgba(0, 0, 0, 0.45);
            }

            :host([open]) ul {
                display: block;
            }

            li {
                display: flex;
                align-items: baseline;
                gap: 8px;
                padding: 3px 10px;
                color: #e4e4e4;
                cursor: pointer;
                white-space: nowrap;
            }

            li.active,
            li:hover {
                background: #2f5d8a;
                color: #fff;
            }

            .ref {
                font-weight: 700;
                min-width: 42px;
            }

            .tag {
                font-size: 10px;
                padding: 0 4px;
                border-radius: 3px;
                background: #4a4a4e;
                color: #d0d0d0;
            }

            .desc {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                color: #b0b0b0;
            }

            li.active .desc,
            li:hover .desc {
                color: #e0e0e0;
            }

            a {
                color: #8fc0ff;
                font-size: 11px;
            }

            .empty {
                padding: 4px 10px;
                color: #9a9a9a;
            }
        `,
    ];

    static pick_event = "kicanvas:search-pick";
    static focus_event = "kicanvas:search-focus";

    #items: SearchItem[] = [];
    #results: SearchItem[] = [];
    #active = 0;

    /** What can be searched for. */
    set items(items: SearchItem[]) {
        this.#items = items;
        this.#run();
    }

    get #input() {
        return this.renderRoot.querySelector("input")!;
    }

    get #list() {
        return this.renderRoot.querySelector("ul")!;
    }

    #set_open(open: boolean) {
        this.toggleAttribute("open", open);
    }

    #run() {
        if (!this.renderRoot?.querySelector("input")) {
            return;
        }
        const query = this.#input.value;
        this.#results = search(this.#items, query);
        this.#active = 0;
        this.#render_list();
        this.#set_open(query.trim().length >= 2);
    }

    #render_list() {
        const list = this.#list;
        list.replaceChildren();

        if (!this.#results.length) {
            list.append(html`<div class="empty">No matches</div>`);
            return;
        }

        this.#results.forEach((item, i) => {
            const li =
                item.kind == "part"
                    ? html`<li data-i="${i}">
                          <span class="ref">${item.reference}</span>
                          <span class="desc"
                              >${[item.mpn, item.value]
                                  .filter(
                                      (s, j, all) => s && all.indexOf(s) == j,
                                  )
                                  .join(" · ")}</span
                          >
                          ${item.id
                              ? html`<a
                                    href="${factorify_href(item.id) ?? ""}"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Open in Factorify"
                                    >ID ${item.id}</a
                                >`
                              : null}
                      </li>`
                    : html`<li data-i="${i}">
                          <span class="tag">NET</span>
                          <span class="desc">${item.name}</span>
                      </li>`;
            (li as HTMLElement).classList.toggle("active", i == this.#active);
            list.append(li);
        });
    }

    #move(delta: number) {
        if (!this.#results.length) {
            return;
        }
        this.#active =
            (this.#active + delta + this.#results.length) %
            this.#results.length;
        const items = this.#list.querySelectorAll("li");
        items.forEach((li, i) =>
            li.classList.toggle("active", i == this.#active),
        );
        items[this.#active]?.scrollIntoView({ block: "nearest" });
    }

    #pick(i: number) {
        const item = this.#results[i];
        if (!item) {
            return;
        }
        this.#set_open(false);
        this.dispatchEvent(
            new CustomEvent(KCSearchBoxElement.pick_event, {
                detail: item,
                bubbles: true,
                composed: true,
            }),
        );
    }

    override initialContentCallback() {
        const input = this.#input;

        input.addEventListener("input", () => this.#run());

        input.addEventListener("keydown", (e) => {
            switch (e.key) {
                case "ArrowDown":
                    e.preventDefault();
                    this.#move(1);
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    this.#move(-1);
                    break;
                case "Enter":
                    e.preventDefault();
                    this.#pick(this.#active);
                    break;
                case "Escape":
                    e.preventDefault();
                    if (this.hasAttribute("open")) {
                        this.#set_open(false);
                    } else {
                        input.value = "";
                        input.blur();
                    }
                    break;
            }
        });

        const notify_focus = (focused: boolean) =>
            this.dispatchEvent(
                new CustomEvent(KCSearchBoxElement.focus_event, {
                    detail: focused,
                    bubbles: true,
                    composed: true,
                }),
            );
        input.addEventListener("focus", () => {
            notify_focus(true);
            if (input.value.trim().length >= 2) {
                this.#run();
            }
        });
        input.addEventListener("blur", () => {
            notify_focus(false);
            // Let clicks on the list happen first.
            window.setTimeout(() => this.#set_open(false), 150);
        });

        // Pick with the mouse; links (Factorify) just open.
        this.#list.addEventListener("mousedown", (e) => {
            if ((e.target as Element).closest("a")) {
                return;
            }
            e.preventDefault();
            const li = (e.target as Element).closest("li");
            if (li) {
                this.#pick(parseInt(li.getAttribute("data-i") ?? "-1", 10));
            }
        });
    }

    /** Puts the cursor in the search field. */
    override focus() {
        this.#input.focus();
        this.#input.select();
    }

    override render() {
        return html`<input
                type="search"
                spellcheck="false"
                autocomplete="off"
                placeholder="Search: reference, ID, MPN, net…"
                title="Search parts and nets (/)" />
            <ul></ul>`;
    }
}

window.customElements.define("kc-search-box", KCSearchBoxElement);
