/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import { WORKTREE, type Commit, type GitInfo } from "../../compare/revisions";

/**
 * The project's revisions from its git history (and the working copy), to
 * choose which one is shown. Fires KCRevisionListElement.pick_event with
 * the chosen revision: a commit's SHA, or WORKTREE.
 */
export class KCRevisionListElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                display: flex;
                flex-direction: column;
                min-height: 0;
                font-size: 12px;
                color: #e4e4e4;
            }

            input {
                margin: 2px 2px 4px;
                padding: 2px 6px;
                font: inherit;
                font-size: 11px;
                color: #e4e4e4;
                background: #222224;
                border: 1px solid #575757;
                border-radius: 3px;
                outline: none;
            }

            input:focus {
                border-color: #4a86c5;
            }

            ul {
                list-style: none;
                margin: 0;
                padding: 0 1px 2px;
                max-height: min(55vh, 420px);
                overflow-y: auto;
            }

            li {
                display: grid;
                grid-template-columns: auto 1fr;
                column-gap: 6px;
                padding: 2px 5px;
                border-radius: 3px;
                cursor: pointer;
            }

            li:hover {
                background: #48484b;
            }

            li.current {
                background: #2f5d8a;
                color: #fff;
            }

            .sha {
                font-family: ui-monospace, monospace;
                font-size: 11px;
                color: #8fb8f0;
            }

            li.current .sha {
                color: #fff;
            }

            .date {
                color: #9a9a9a;
                font-size: 11px;
                text-align: right;
            }

            li.current .date {
                color: #dcdcdc;
            }

            .subject {
                grid-column: 1 / -1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .note {
                padding: 4px 6px;
                color: #9a9a9a;
                font-size: 11px;
            }
        `,
    ];

    static pick_event = "kicanvas:revision-pick";

    #info?: GitInfo;
    #commits: Commit[] = [];
    #current = WORKTREE;

    /** Shows the history; `current` is the revision being shown. */
    set_history(info: GitInfo, commits: Commit[], current: string) {
        this.#info = info;
        this.#commits = commits;
        this.#current = current;
        this.#render_list();
    }

    set current(rev: string) {
        this.#current = rev;
        this.#render_list();
    }

    #render_list() {
        const list = this.renderRoot.querySelector("ul");
        const filter = (this.renderRoot.querySelector("input")?.value ?? "")
            .trim()
            .toLowerCase();
        if (!list) {
            return;
        }

        const item = (
            rev: string,
            sha: string,
            date: string,
            subject: string,
            title: string,
        ) => {
            const li = html`<li title="${title}">
                <span class="sha">${sha}</span>
                <span class="date">${date}</span>
                <span class="subject">${subject}</span>
            </li>` as HTMLElement;
            li.classList.toggle("current", rev == this.#current);
            li.addEventListener("click", () => {
                this.dispatchEvent(
                    new CustomEvent(KCRevisionListElement.pick_event, {
                        detail: rev,
                        bubbles: true,
                        composed: true,
                    }),
                );
            });
            return li;
        };

        const items: HTMLElement[] = [];
        if (!filter || "working copy".includes(filter)) {
            items.push(
                item(
                    WORKTREE,
                    "working copy",
                    "",
                    this.#info?.dirty
                        ? "With changes that aren't committed"
                        : "Same as the newest commit",
                    "The files as they are on disk",
                ),
            );
        }
        for (const c of this.#commits) {
            const text = `${c.short} ${c.subject} ${c.author}`.toLowerCase();
            if (filter && !text.includes(filter)) {
                continue;
            }
            items.push(
                item(
                    c.sha,
                    c.short,
                    c.date.slice(0, 10),
                    c.subject,
                    `${c.short} · ${c.date.slice(0, 16).replace("T", " ")} · ${c.author}\n${c.subject}`,
                ),
            );
        }
        list.replaceChildren(...items);
        if (!items.length) {
            list.append(html`<div class="note">No matching commits</div>`);
        }
        // Scroll the list (only) to the current revision.
        const current = list.querySelector<HTMLElement>("li.current");
        if (current && list.clientHeight) {
            const top = current.offsetTop - list.offsetTop;
            if (
                top < list.scrollTop ||
                top > list.scrollTop + list.clientHeight - 30
            ) {
                list.scrollTop = Math.max(0, top - list.clientHeight / 2);
            }
        }
    }

    override initialContentCallback() {
        this.renderRoot
            .querySelector("input")!
            .addEventListener("input", () => this.#render_list());
        this.#render_list();
    }

    override render() {
        return html`<input
                type="search"
                placeholder="Filter commits…"
                spellcheck="false" />
            <ul></ul>`;
    }
}

window.customElements.define("kc-revision-list", KCRevisionListElement);
