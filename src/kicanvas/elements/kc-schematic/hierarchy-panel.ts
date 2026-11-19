/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { delegate } from "../../../base/events";
import { css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import type { Project, ProjectPage } from "../../project";
import { CrossProbe } from "../../cross-probe";
import { KCViewerAppElement } from "../common/app";

type Node = { page: ProjectPage; children: Node[] };

/**
 * Sheet hierarchy tree, like KiCad's hierarchy navigator. Clicking a sheet
 * shows it.
 */
export class KCSchematicHierarchyPanelElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                display: block;
                padding: 2px 0;
                user-select: none;
            }

            ul {
                list-style: none;
                margin: 0;
                padding: 0;
            }

            li > ul {
                padding-left: 12px;
            }

            li.collapsed > ul {
                display: none;
            }

            .row {
                display: flex;
                align-items: center;
                gap: 4px;
                height: 20px;
                padding: 0 6px 0 2px;
                cursor: pointer;
                white-space: nowrap;
            }

            .row:hover {
                background: var(--fp-hover-bg, #48484b);
            }

            .row.current {
                background: var(--fp-selected-bg, #2f5d8a);
                color: var(--fp-selected-fg, #fff);
            }

            .twisty {
                flex: 0 0 12px;
                height: 16px;
                display: grid;
                place-items: center;
            }

            .twisty.branch::before {
                content: "";
                border-left: 4px solid var(--fp-muted, #9a9a9a);
                border-top: 3.5px solid transparent;
                border-bottom: 3.5px solid transparent;
                transform: rotate(90deg);
                transition: transform 0.1s ease;
            }

            li.collapsed > .row .twisty.branch::before {
                transform: none;
            }

            .icon {
                flex: 0 0 auto;
                width: 9px;
                height: 11px;
                border: 1px solid currentColor;
                border-radius: 1px;
                opacity: 0.7;
            }

            .name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .page {
                color: var(--fp-muted, #9a9a9a);
                font-variant-numeric: tabular-nums;
            }

            .current .page {
                color: inherit;
            }

            /* Sheets with the net or part selected for cross-probing */
            .row.probed .name::after {
                content: "";
                display: inline-block;
                width: 6px;
                height: 6px;
                margin-left: 6px;
                border-radius: 50%;
                background: #ff9f1a;
                vertical-align: middle;
            }

            .label {
                padding: 6px 6px 2px;
                font-size: 11px;
                color: var(--fp-muted, #9a9a9a);
            }
        `,
    ];

    project: Project;
    #current?: string;

    override connectedCallback() {
        (async () => {
            this.project = await this.requestContext("project");
            await this.project.loaded;
            super.connectedCallback();
        })();
    }

    override initialContentCallback() {
        delegate(this.renderRoot, ".twisty.branch", "click", (e, source) => {
            e.stopPropagation();
            source.closest("li")?.classList.toggle("collapsed");
        });

        delegate(this.renderRoot, ".row", "click", (e, source) => {
            const page = this.project.page_by_path(
                source.getAttribute("data-path") ?? "",
            );
            if (page) {
                this.project.set_active_page(page);
            }
        });

        // Mark sheets with the cross-probed net or part.
        const on_probe = (e: Event) => {
            const paths = (e as CustomEvent<Set<string>>).detail;
            for (const row of this.renderRoot.querySelectorAll(".row")) {
                row.classList.toggle(
                    "probed",
                    paths.has(row.getAttribute("data-path") ?? ""),
                );
            }
        };
        window.addEventListener(CrossProbe.pages_event, on_probe);
        this.addDisposable({
            dispose: () =>
                window.removeEventListener(CrossProbe.pages_event, on_probe),
        });

        // Follow whichever sheet the schematic app shows.
        const on_page_loaded = (e: Event) => {
            const page = (e as CustomEvent<ProjectPage>).detail;
            if (page?.type == "schematic") {
                this.#current = page.project_path;
                this.#update_current();
            }
        };
        window.addEventListener(
            KCViewerAppElement.page_loaded_event,
            on_page_loaded,
        );
        this.addDisposable({
            dispose: () =>
                window.removeEventListener(
                    KCViewerAppElement.page_loaded_event,
                    on_page_loaded,
                ),
        });
    }

    #update_current() {
        for (const row of this.renderRoot.querySelectorAll(".row")) {
            row.classList.toggle(
                "current",
                row.getAttribute("data-path") == this.#current,
            );
        }
    }

    #build_tree() {
        const root = this.project.root_schematic_page;
        const pages = [...this.project.pages()].filter(
            (p) => p.type == "schematic",
        );
        const nodes = new Map<string, Node>();
        const top: Node[] = [];
        const orphans: ProjectPage[] = [];

        // Create all nodes first: pages are ordered by page number, and a
        // sheet can have a lower page number than its parent.
        for (const page of pages) {
            if (page.page === undefined && page != root) {
                orphans.push(page);
            } else {
                nodes.set(page.sheet_path, { page, children: [] });
            }
        }

        for (const node of nodes.values()) {
            const path = node.page.sheet_path;
            const parent = nodes.get(path.slice(0, path.lastIndexOf("/")));
            if (parent && node.page != root) {
                parent.children.push(node);
            } else {
                top.push(node);
            }
        }

        // Root first, then by page number.
        const by_page = (a: Node, b: Node) =>
            (a.page == root ? -1 : 0) - (b.page == root ? -1 : 0) ||
            (a.page.page ?? "").localeCompare(b.page.page ?? "", undefined, {
                numeric: true,
            });
        const sort = (list: Node[]) => {
            list.sort(by_page);
            list.forEach((n) => sort(n.children));
        };
        sort(top);

        return { top, orphans };
    }

    #row(page: ProjectPage, has_children: boolean, label?: string) {
        const current = page.project_path == this.#current ? "current" : "";
        return html`<div
            class="row ${current}"
            data-path="${page.project_path}"
            title="${page.filename}">
            <span class="twisty ${has_children ? "branch" : ""}"></span>
            <span class="icon"></span>
            <span class="name">${label ?? page.name ?? page.filename}</span>
            <span class="page">${page.page ?? ""}</span>
        </div>`;
    }

    #node(node: Node): ReturnType<typeof html> {
        const is_root = node.page == this.project.root_schematic_page;
        const label = is_root ? this.project.name || "Root" : undefined;
        return html`<li>
            ${this.#row(node.page, node.children.length > 0, label)}
            ${node.children.length
                ? html`<ul>
                      ${node.children.map((c) => this.#node(c))}
                  </ul>`
                : null}
        </li>`;
    }

    override render() {
        const { top, orphans } = this.#build_tree();

        if (!this.#current) {
            const active = this.project.active_page;
            this.#current =
                active?.type == "schematic"
                    ? active.project_path
                    : this.project.root_schematic_page?.project_path;
        }

        return html`<ul>
                ${top.map((n) => this.#node(n))}
            </ul>
            ${orphans.length
                ? html`<div class="label">Not in hierarchy</div>
                      <ul>
                          ${orphans.map(
                              (p) => html`<li>${this.#row(p, false)}</li>`,
                          )}
                      </ul>`
                : null}`;
    }
}

window.customElements.define(
    "kc-schematic-hierarchy-panel",
    KCSchematicHierarchyPanelElement,
);
