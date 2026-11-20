/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox } from "../../../base/math";
import { css, html } from "../../../base/web-components";
import { Color } from "../../../graphics";
import type { KicadPCB } from "../../../kicad";
import { Footprint } from "../../../kicad/board";
import {
    KicadSch,
    SchematicSheet,
    SchematicSymbol,
} from "../../../kicad/schematic";
import {
    KCUIButtonElement,
    KCUIElement,
    KCUIFloatingPanelElement,
} from "../../../kc-ui";
import {
    KiCanvasActivateEvent,
    KiCanvasLayersChangedEvent,
    KiCanvasLoadEvent,
    KiCanvasSelectEvent,
    KiCanvasViewportEvent,
} from "../../../viewers/base/events";
import type { Annotation, Viewer } from "../../../viewers/base/viewer";
import type { BoardViewer } from "../../../viewers/board/viewer";
import type { SchematicViewer } from "../../../viewers/schematic/viewer";
import { CrossProbeIndex, reference_in } from "../../cross-probe";
import {
    compare_projects,
    type Category,
    type Change,
    type Comparison,
} from "../../compare/diff";
import {
    bom_csv,
    category_names,
    changes_csv,
    download_text,
    json_report,
    markdown_report,
} from "../../compare/report";
import {
    WORKTREE,
    git_commits,
    git_info,
    load_revision,
    type Commit,
    type GitInfo,
} from "../../compare/revisions";
import type { Project, ProjectPage } from "../../project";
import type { KCBoardViewerElement } from "../kc-board/viewer";
import type { KCSchematicViewerElement } from "../kc-schematic/viewer";

import "../kc-board/appearance-panel";
import "../kc-board/viewer";
import "../kc-schematic/viewer";

export type CompareMode = "highlight" | "stacked" | "overlay" | "blink";

const modes: { mode: CompareMode; title: string; icon: string }[] = [
    {
        mode: "highlight",
        title: "Changes highlighted in B, removed items as ghosts (1)",
        icon: "difference",
    },
    { mode: "stacked", title: "A above B (2)", icon: "splitscreen" },
    {
        mode: "overlay",
        title: "B over A, with adjustable transparency (3)",
        icon: "layers",
    },
    { mode: "blink", title: "Alternate A and B (4)", icon: "animation" },
];

const colors = {
    added: Color.from_css("#4d8fe6"),
    removed: Color.from_css("#f07a1a"),
    modified: Color.from_css("#c27ae8"),
};

function first_board(project: Project) {
    for (const page of project.pages()) {
        if (page.type == "pcb") {
            return page;
        }
    }
    return undefined;
}

function hierarchy_pages(project: Project): ProjectPage[] {
    return [...project.pages()]
        .filter(
            (p) =>
                p.type == "schematic" &&
                (p.page !== undefined || p == project.root_schematic_page),
        )
        .sort(
            (a, b) =>
                (parseInt(a.page ?? "0", 10) || 0) -
                (parseInt(b.page ?? "0", 10) || 0),
        );
}

function page_name(page: ProjectPage) {
    return page.sheet?.sheetname ?? page.name ?? page.filename;
}

function short_date(iso: string) {
    return iso.slice(0, 10);
}

/** Loads a page into a viewer element and waits until it's shown. */
function load_into(
    elm: KCSchematicViewerElement | KCBoardViewerElement,
    page: ProjectPage,
) {
    return new Promise<void>((resolve) => {
        const once = elm.viewer.addEventListener(KiCanvasLoadEvent.type, () => {
            once.dispose();
            resolve();
        });
        elm.load(page);
    });
}

/**
 * Compares two revisions of the project from its git history: the
 * schematic on the left and the board on the right, like the viewer, with
 * revision A (older) and B (newer) shown in one of four ways.
 */
export class KCCompareWorkspaceElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                position: absolute;
                z-index: 2;
                inset: 0 0 20px 0;
                display: flex;
                background: #1b1b1d;
                color: #e4e4e4;
                font-size: 12px;
            }

            .col {
                position: relative;
                display: flex;
                flex-direction: column;
                min-width: 0;
                min-height: 0;
                overflow: hidden;
            }

            .col.sch {
                flex: 0 0 50%;
            }

            .col.pcb {
                flex: 1 1 0;
            }

            .slot {
                position: relative;
                flex: 1 1 0;
                min-height: 0;
                display: flex;
            }

            .slot > kc-schematic-viewer,
            .slot > kc-board-viewer {
                flex: 1;
                min-width: 0;
            }

            .slot.a {
                flex: 0 0 50%;
            }

            /* All modes but "stacked" show A and B in the same place. */
            :host(:not([mode="stacked"])) .slot {
                position: absolute;
                inset: 0;
            }

            :host(:not([mode="stacked"])) kc-ui-divider[horizontal] {
                display: none;
            }

            :host([mode="highlight"]) .slot.a {
                z-index: 1;
                visibility: hidden;
                opacity: 0.5;
                pointer-events: none;
            }

            :host([mode="highlight"]) .slot.a.ghosts {
                visibility: visible;
            }

            :host([mode="overlay"]) .slot.b,
            :host([mode="blink"]) .slot.b {
                z-index: 1;
            }

            :host([mode="overlay"]) .slot.b {
                opacity: var(--overlay-opacity, 0.5);
            }

            :host([mode="blink"]) .slot.b.off {
                visibility: hidden;
            }

            .tag {
                position: absolute;
                z-index: 3;
                left: 8px;
                bottom: 8px;
                max-width: calc(100% - 16px);
                padding: 3px 7px;
                border-radius: 4px;
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                background: rgba(40, 40, 42, 0.92);
                border: 1px solid #575757;
                pointer-events: none;
            }

            .tag.a {
                color: #f6a35e;
            }

            .tag.b {
                color: #8fb8f0;
            }

            :host(:not([mode="stacked"])) .slot.a .tag {
                display: none;
            }

            :host([mode="blink"]) .slot.b.off .tag {
                display: none;
            }

            .missing {
                position: absolute;
                inset: 0;
                z-index: 2;
                display: none;
                place-items: center;
                color: #9a9a9a;
                background: #1b1b1d;
            }

            .slot.empty .missing {
                display: grid;
            }

            .message {
                position: absolute;
                z-index: 20;
                left: 50%;
                top: 45%;
                transform: translate(-50%, -50%);
                max-width: 70%;
                padding: 12px 16px;
                border-radius: 4px;
                background: rgba(40, 40, 42, 0.97);
                border: 1px solid #575757;
                box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
                text-align: center;
                line-height: 1.5;
            }

            .message[hidden] {
                display: none;
            }

            /* Palette content */
            .form {
                display: grid;
                grid-template-columns: auto 1fr;
                gap: 4px 6px;
                align-items: center;
                padding: 6px;
            }

            select,
            button.small,
            input[type="range"] {
                font: inherit;
                font-size: 11px;
                min-width: 0;
                color: #e4e4e4;
                background: #222224;
                border: 1px solid #575757;
                border-radius: 3px;
            }

            select {
                width: 100%;
                padding: 1px 2px;
            }

            button.small {
                padding: 2px 8px;
                cursor: pointer;
            }

            button.small:hover {
                background: #48484b;
            }

            .rev-label {
                font-weight: 700;
            }

            .rev-label.a {
                color: #f6a35e;
            }

            .rev-label.b {
                color: #8fb8f0;
            }

            .note {
                grid-column: 1 / -1;
                color: #9a9a9a;
                font-size: 11px;
            }

            .row {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 2px 6px;
            }

            .row label {
                display: flex;
                align-items: center;
                gap: 5px;
                flex: 1;
                cursor: pointer;
            }

            .row .count {
                color: #9a9a9a;
                font-variant-numeric: tabular-nums;
            }

            .buttons {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                padding: 4px 6px 6px;
            }

            h4 {
                margin: 6px 6px 2px;
                font-size: 11px;
                font-weight: 600;
                color: #9a9a9a;
            }

            ul.list {
                list-style: none;
                margin: 0;
                padding: 2px 3px 4px;
            }

            ul.list li {
                display: flex;
                align-items: baseline;
                gap: 6px;
                padding: 2px 4px;
                border-radius: 3px;
                cursor: pointer;
            }

            ul.list li:hover {
                background: #48484b;
            }

            ul.list li.selected {
                background: #2f5d8a;
                color: #fff;
            }

            ul.list li.current {
                font-weight: 600;
            }

            ul.list .dot {
                flex: 0 0 auto;
                width: 7px;
                height: 7px;
                border-radius: 50%;
                transform: translateY(-1px);
            }

            .dot.added {
                background: #4d8fe6;
            }

            .dot.removed {
                background: #f07a1a;
            }

            .dot.modified {
                background: #c27ae8;
            }

            ul.list .text {
                flex: 1;
                min-width: 0;
            }

            ul.list .detail {
                display: block;
                color: #a8a8a8;
                font-size: 11px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            ul.list li.selected .detail {
                color: #dcdcdc;
                white-space: normal;
            }

            ul.list .count {
                margin-left: auto;
                color: #9a9a9a;
            }

            .group {
                margin: 6px 6px 1px;
                font-size: 11px;
                font-weight: 600;
                color: #9a9a9a;
            }
        `,
    ];

    #sch_a: KCSchematicViewerElement;
    #sch_b: KCSchematicViewerElement;
    #pcb_a: KCBoardViewerElement;
    #pcb_b: KCBoardViewerElement;

    #info?: GitInfo;
    #commits: Commit[] = [];
    #rev_a = "";
    #rev_b = "";
    #project_a?: Project;
    #project_b?: Project;
    #index_a?: CrossProbeIndex;
    #index_b?: CrossProbeIndex;
    #result?: Comparison;
    #sheet_path = "";
    #mode: CompareMode = "highlight";
    #shown = new Set<Category>(["components", "nets", "layout"]);
    #selected?: Change;
    #blink_timer = 0;
    #load_token = 0;
    #syncing = false;
    #active = false;

    #toolbar_left: KCUIButtonElement[] = [];
    #toolbar_right: KCUIButtonElement[] = [];

    /** Fired when the hint line should change; detail: text or null */
    static hint_event = "kicanvas:hint";

    constructor() {
        super();
        // The board layers panel controls revision B (A follows it).
        this.provideLazyContext("viewer", () => this.#pcb_b?.viewer);
        this.#make_toolbars();
    }

    /** Buttons for the left (schematic) side of the toolbar row. */
    get toolbar_left(): readonly KCUIButtonElement[] {
        return this.#toolbar_left;
    }

    /** Buttons for the right (board) side of the toolbar row. */
    get toolbar_right(): readonly KCUIButtonElement[] {
        return this.#toolbar_right;
    }

    /** The width of the schematic column, for placing the toolbar row. */
    get split_x(): number {
        return (
            this.renderRoot.querySelector<HTMLElement>(".col.sch")
                ?.offsetWidth ?? 0
        );
    }

    #button(name: string, title: string, icon: string) {
        const b = html`<kc-ui-button
            variant="toolbar"
            name="${name}"
            title="${title}"
            icon="${icon}">
        </kc-ui-button>` as KCUIButtonElement;
        b.addEventListener("click", (e) => {
            e.preventDefault();
            this.#on_button(name);
        });
        return b;
    }

    #make_toolbars() {
        this.#toolbar_left = [
            this.#button(
                "leave_sheet",
                "Up to the parent sheet (Alt+Backspace)",
                "arrow_upward",
            ),
            ...modes.map((m) =>
                this.#button(`mode_${m.mode}`, m.title, m.icon),
            ),
        ];
        this.#toolbar_right = [
            this.#button("zoom_to_fit", "Fit to design", "fit_screen"),
            this.#button(
                "previous",
                "Previous change (Shift+Z)",
                "navigate_before",
            ),
            this.#button("next", "Next change (Z)", "navigate_next"),
            this.#button("flip_view", "Flip board view", "flip"),
        ];
        this.#sync_mode_buttons();
    }

    #on_button(name: string) {
        if (name.startsWith("mode_")) {
            this.mode = name.slice(5) as CompareMode;
            return;
        }
        switch (name) {
            case "leave_sheet": {
                const parts = this.#sheet_path.split("/").filter(Boolean);
                if (parts.length > 1) {
                    this.#show_sheet(`/${parts.slice(0, -1).join("/")}`);
                }
                break;
            }
            case "zoom_to_fit":
                // Fit to the selected change, if there is one.
                if (this.#selected) {
                    this.select_change(this.#selected);
                    break;
                }
                this.#sch_b.viewer.zoom_to_fit();
                this.#pcb_b.viewer.zoom_to_fit();
                this.#copy_camera(this.#sch_b.viewer, this.#sch_a.viewer);
                this.#copy_camera(this.#pcb_b.viewer, this.#pcb_a.viewer);
                break;
            case "previous":
                this.#step(-1);
                break;
            case "next":
                this.#step(1);
                break;
            case "flip_view":
                this.#pcb_a.viewer.flip_view();
                this.#pcb_b.viewer.flip_view();
                this.#toolbar_right.find(
                    (b) => b.name == "flip_view",
                )!.selected = this.#pcb_b.viewer.viewport.camera.flipped;
                break;
        }
    }

    get mode() {
        return this.#mode;
    }

    set mode(mode: CompareMode) {
        this.#mode = mode;
        this.setAttribute("mode", mode);
        this.#sync_mode_buttons();

        window.clearInterval(this.#blink_timer);
        for (const slot of this.renderRoot.querySelectorAll(".slot.b")) {
            slot.classList.remove("off");
        }
        if (mode == "blink") {
            this.#blink_timer = window.setInterval(() => {
                for (const slot of this.renderRoot.querySelectorAll(
                    ".slot.b",
                )) {
                    slot.classList.toggle("off");
                }
            }, 700);
        }
        const opacity =
            this.renderRoot.querySelector<HTMLElement>(".opacity-row");
        if (opacity) {
            opacity.hidden = mode != "overlay";
        }
        this.#update_marks();
        this.#hint();
    }

    #sync_mode_buttons() {
        for (const b of this.#toolbar_left) {
            if (b.name?.startsWith("mode_")) {
                b.selected = b.name == `mode_${this.#mode}`;
            }
        }
    }

    #hint(text?: string) {
        window.dispatchEvent(
            new CustomEvent(KCCompareWorkspaceElement.hint_event, {
                detail: {
                    source: "compare",
                    text: this.#active
                        ? (text ??
                          "Compare · 1–4: view mode · Z / Shift+Z: next / previous change · Double click: open sheet · Esc: clear")
                        : null,
                },
            }),
        );
    }

    #message(text: string | null) {
        const elm = this.renderRoot.querySelector<HTMLElement>(".message");
        if (elm) {
            elm.hidden = !text;
            elm.textContent = text ?? "";
        }
    }

    /** The compared revisions and the view mode, e.g. for shared links. */
    get state() {
        return { a: this.#rev_a, b: this.#rev_b, mode: this.#mode };
    }

    /**
     * Starts comparing: loads the history and the default revisions, or
     * the given ones.
     */
    async enter(revisions?: { a: string; b: string; mode?: CompareMode }) {
        if (revisions?.mode) {
            this.#mode = revisions.mode;
        }
        this.#active = true;
        this.hidden = false;
        this.mode = this.#mode;
        await Promise.all(
            [this.#sch_a, this.#sch_b, this.#pcb_a, this.#pcb_b].map(
                (e) => e.ready,
            ),
        );

        if (!this.#info) {
            this.#message("Reading the git history…");
            this.#info = await git_info();
            if (!this.#info.available) {
                this.#message(
                    "Comparing revisions needs the project's git history: open the project from its git clone with “npm run open -- <directory>”.",
                );
                return;
            }
            try {
                this.#commits = await git_commits();
            } catch (e) {
                this.#message(`Couldn't read the git history: ${e}`);
                return;
            }
            if (!this.#commits.length) {
                this.#message("The project has no commits to compare.");
                return;
            }
            // B: the working copy if it has changes, else the newest
            // commit; A: the commit before.
            const known = (rev: string) =>
                rev == WORKTREE || this.#commits.some((c) => c.sha == rev);
            if (revisions && known(revisions.a) && known(revisions.b)) {
                this.#rev_a = revisions.a;
                this.#rev_b = revisions.b;
            } else if (this.#info.dirty) {
                this.#rev_b = WORKTREE;
                this.#rev_a = this.#commits[0]!.sha;
            } else {
                this.#rev_b = this.#commits[0]!.sha;
                this.#rev_a = (this.#commits[1] ?? this.#commits[0]!).sha;
            }
            this.#render_revisions();
            await this.#compare();
        } else {
            this.#update_marks();
        }
    }

    /** Stops comparing. */
    leave() {
        this.#active = false;
        this.hidden = true;
        window.clearInterval(this.#blink_timer);
        this.#hint();
    }

    get active() {
        return this.#active;
    }

    #label(rev: string) {
        if (rev == WORKTREE) {
            return "Working copy";
        }
        const c = this.#commits.find((c) => c.sha == rev);
        return c ? `${c.short} ${c.subject}` : rev.slice(0, 7);
    }

    #short_label(rev: string) {
        if (rev == WORKTREE) {
            return "working copy";
        }
        return this.#commits.find((c) => c.sha == rev)?.short ?? rev;
    }

    async #compare() {
        const token = ++this.#load_token;
        this.#selected = undefined;
        this.#update_fit_button();
        this.#message(
            `Loading ${this.#short_label(this.#rev_a)} and ${this.#short_label(this.#rev_b)}…`,
        );
        let a: Project, b: Project;
        try {
            [a, b] = await Promise.all([
                load_revision(this.#rev_a),
                load_revision(this.#rev_b),
            ]);
        } catch (e) {
            this.#message(`Loading failed: ${e}`);
            return;
        }
        if (token != this.#load_token) {
            return;
        }

        this.#message("Comparing…");
        await new Promise((r) => window.setTimeout(r));
        try {
            this.#result = compare_projects(a, b);
        } catch (e) {
            console.error(e);
            this.#message(`Comparing failed: ${e}`);
            return;
        }
        this.#project_a = a;
        this.#project_b = b;
        const board = (p: Project) =>
            first_board(p)?.document as KicadPCB | undefined;
        this.#index_a = new CrossProbeIndex(
            a,
            board(a) ?? ({ footprints: [] } as unknown as KicadPCB),
        );
        this.#index_b = new CrossProbeIndex(
            b,
            board(b) ?? ({ footprints: [] } as unknown as KicadPCB),
        );
        this.#message(null);

        this.#render_tools();
        this.#render_changes();

        // Keep the sheet if B has it.
        const root = b.root_schematic_page;
        const keep =
            this.#sheet_path && b.page_by_sheet_path(this.#sheet_path)
                ? this.#sheet_path
                : (root?.sheet_path ?? "");
        await Promise.all([this.#show_sheet(keep, true), this.#show_boards()]);
        if (token == this.#load_token) {
            this.#hint(
                `Comparing ${this.#short_label(this.#rev_a)} (A) with ${this.#short_label(this.#rev_b)} (B): ${this.#result.changes.length} changes`,
            );
        }
    }

    // Views

    #copy_camera(from: Viewer, to: Viewer) {
        if (!from.viewport || !to.viewport || this.#syncing) {
            return;
        }
        // If the layout moved as a whole, A is shown aligned to B.
        const shift = this.#result?.shift;
        let dx = 0;
        let dy = 0;
        if (shift && from == this.#pcb_b.viewer && to == this.#pcb_a.viewer) {
            dx = -shift.dx;
            dy = -shift.dy;
        } else if (
            shift &&
            from == this.#pcb_a.viewer &&
            to == this.#pcb_b.viewer
        ) {
            dx = shift.dx;
            dy = shift.dy;
        }
        this.#syncing = true;
        try {
            to.viewport.camera.center.set(
                from.viewport.camera.center.x + dx,
                from.viewport.camera.center.y + dy,
            );
            to.viewport.camera.zoom = from.viewport.camera.zoom;
            to.viewport.user_moved_camera = true;
            to.draw();
        } finally {
            this.#syncing = false;
        }
        this.#update_ghosts();
    }

    /** Shows a sheet (by sheet path) of both revisions. */
    async #show_sheet(sheet_path: string, fit = true) {
        const a = this.#project_a;
        const b = this.#project_b;
        if (!a || !b) {
            return;
        }
        this.#sheet_path = sheet_path;
        const page_a = a.page_by_sheet_path(sheet_path);
        const page_b = b.page_by_sheet_path(sheet_path);
        const slot_a = this.#sch_a.parentElement!;
        const slot_b = this.#sch_b.parentElement!;
        slot_a.classList.toggle("empty", !page_a);
        slot_b.classList.toggle("empty", !page_b);
        await Promise.all([
            page_a ? load_into(this.#sch_a, page_a) : null,
            page_b ? load_into(this.#sch_b, page_b) : null,
        ]);
        const shown = page_b ? this.#sch_b.viewer : this.#sch_a.viewer;
        if (fit) {
            (shown as SchematicViewer).zoom_to_content();
        }
        this.#copy_camera(
            shown,
            shown == this.#sch_b.viewer
                ? this.#sch_a.viewer
                : this.#sch_b.viewer,
        );

        const name = page_b ?? page_a;
        this.renderRoot.querySelector(".slot.a .tag")!.textContent =
            `A · ${this.#label(this.#rev_a)}`;
        this.renderRoot.querySelector(".slot.b .tag")!.textContent =
            `B · ${this.#label(this.#rev_b)}${name ? ` · ${page_name(name)}` : ""}`;
        this.renderRoot.querySelector(".pcb .slot.a .tag")!.textContent =
            `A · ${this.#label(this.#rev_a)}`;
        this.renderRoot.querySelector(".pcb .slot.b .tag")!.textContent =
            `B · ${this.#label(this.#rev_b)}`;

        const up = this.#toolbar_left.find((x) => x.name == "leave_sheet");
        if (up) {
            up.disabled = sheet_path.split("/").filter(Boolean).length < 2;
        }
        this.#render_sheets();
        this.#update_marks();
    }

    async #show_boards() {
        const pa = this.#project_a && first_board(this.#project_a);
        const pb = this.#project_b && first_board(this.#project_b);
        this.#pcb_a.parentElement!.classList.toggle("empty", !pa);
        this.#pcb_b.parentElement!.classList.toggle("empty", !pb);
        await Promise.all([
            pa ? load_into(this.#pcb_a, pa) : null,
            pb ? load_into(this.#pcb_b, pb) : null,
        ]);
        for (const v of [this.#pcb_a.viewer, this.#pcb_b.viewer]) {
            if (v.document) {
                v.show_default_layers();
                v.zone_fills = false;
            }
        }
        this.#copy_camera(this.#pcb_b.viewer, this.#pcb_a.viewer);
        this.#update_marks();
    }

    // Changes

    get #visible_changes(): Change[] {
        return (this.#result?.changes ?? []).filter((c) =>
            this.#shown.has(c.category),
        );
    }

    #step(delta: number) {
        const list = this.#visible_changes;
        if (!list.length) {
            return;
        }
        const i = this.#selected ? list.indexOf(this.#selected) : -1;
        const next =
            list[
                i < 0
                    ? delta > 0
                        ? 0
                        : list.length - 1
                    : (i + delta + list.length) % list.length
            ]!;
        this.select_change(next);
    }

    /** "Fit to design" fits to the selected change, if there is one. */
    #update_fit_button() {
        const fit = this.#toolbar_right.find((b) => b.name == "zoom_to_fit");
        if (fit) {
            fit.icon = this.#selected ? "filter_center_focus" : "fit_screen";
            fit.title = this.#selected
                ? "Fit to the selected change"
                : "Fit to design";
        }
    }

    /** Selects a change and shows it in both views. */
    async select_change(change: Change | undefined, zoom = true) {
        this.#selected = change;
        this.#update_fit_button();
        this.#render_changes();
        if (!change) {
            this.#update_marks();
            return;
        }

        // The schematic: the sheet with the change, if any.
        const sheet =
            change.sch_b[0]?.sheet_path ??
            change.sch_a[0]?.sheet_path ??
            change.sheets[0];
        if (sheet && sheet != this.#sheet_path) {
            await this.#show_sheet(sheet, false);
        } else {
            this.#update_marks();
        }

        if (zoom) {
            const sch = this.#change_sch_bbox(change);
            if (sch) {
                const v = this.#sch_b.viewer.document
                    ? this.#sch_b.viewer
                    : this.#sch_a.viewer;
                v.zoom_to_item(sch);
                this.#copy_camera(
                    v,
                    v == this.#sch_b.viewer
                        ? this.#sch_a.viewer
                        : this.#sch_b.viewer,
                );
            }
            // (A's positions can be shifted from B's, see Comparison.shift.)
            if (change.board_b) {
                this.#pcb_b.viewer.zoom_to_item(change.board_b);
                this.#copy_camera(this.#pcb_b.viewer, this.#pcb_a.viewer);
            } else if (change.board_a) {
                this.#pcb_a.viewer.zoom_to_item(change.board_a);
                this.#copy_camera(this.#pcb_a.viewer, this.#pcb_b.viewer);
            }
        }
        const detail = change.details[0] ? ` · ${change.details[0]}` : "";
        this.#hint(`${change.title}${detail}`);
    }

    /** Symbols of a change on the shown sheet, in revision A or B. */
    #symbols(change: Change, side: "a" | "b"): SchematicSymbol[] {
        const project = side == "a" ? this.#project_a : this.#project_b;
        const page = project?.page_by_sheet_path(this.#sheet_path);
        if (!page) {
            return [];
        }
        const doc = page.document as KicadSch;
        return (side == "a" ? change.sch_a : change.sch_b)
            .filter((l) => l.sheet_path == this.#sheet_path && l.symbol)
            .map((l) => doc.symbols.get(l.symbol))
            .filter((s): s is SchematicSymbol => !!s);
    }

    #symbol_bbox(viewer: SchematicViewer, symbol: SchematicSymbol) {
        for (const bb of viewer.layers?.query_item_bboxes(symbol) ?? []) {
            return bb;
        }
        return undefined;
    }

    /** Sheet nets of a change on the shown sheet. */
    #nets(change: Change, side: "a" | "b") {
        const project = side == "a" ? this.#project_a : this.#project_b;
        const index = side == "a" ? this.#index_a : this.#index_b;
        const page = project?.page_by_sheet_path(this.#sheet_path);
        if (!page || !index) {
            return [];
        }
        return (side == "a" ? change.nets_a : change.nets_b).flatMap((k) =>
            index.sheet_nets_for(page, k),
        );
    }

    #change_sch_bbox(change: Change): BBox | undefined {
        const boxes: BBox[] = [];
        for (const [side, elm] of [
            ["b", this.#sch_b],
            ["a", this.#sch_a],
        ] as const) {
            for (const s of this.#symbols(change, side)) {
                const bb = this.#symbol_bbox(elm.viewer, s);
                if (bb) {
                    boxes.push(bb);
                }
            }
            if (boxes.length) {
                break;
            }
            const nets = this.#nets(change, side);
            if (nets.length) {
                boxes.push(...nets.map((n) => n.bbox));
                break;
            }
        }
        const bbox = BBox.combine(boxes);
        return bbox.valid ? bbox : undefined;
    }

    /** Marks the changes in all views, and the ghosts of removed items. */
    #update_marks() {
        if (!this.#result || !this.#active) {
            return;
        }
        const changes = this.#visible_changes;
        const selected = this.#selected;
        const mark = (
            bbox: BBox | undefined,
            change: Change,
            board: boolean,
        ): Annotation | undefined => {
            if (!bbox?.valid) {
                return undefined;
            }
            const color = colors[change.kind];
            const is_selected = change == selected;
            return {
                bbox,
                color,
                fill: is_selected ? color.with_alpha(0.12) : undefined,
                width: (board ? 0.12 : 0.25) * (is_selected ? 2.5 : 1),
                margin: board ? 0.3 : 0.6,
            };
        };

        for (const side of ["a", "b"] as const) {
            const sch = side == "a" ? this.#sch_a.viewer : this.#sch_b.viewer;
            const pcb = side == "a" ? this.#pcb_a.viewer : this.#pcb_b.viewer;
            const sch_marks: Annotation[] = [];
            const pcb_marks: Annotation[] = [];
            for (const c of changes) {
                // A shows what's gone or changed, B what's new or changed.
                if (c.kind == (side == "a" ? "added" : "removed")) {
                    continue;
                }
                for (const s of sch.document ? this.#symbols(c, side) : []) {
                    const m = mark(this.#symbol_bbox(sch, s), c, false);
                    if (m) sch_marks.push(m);
                }
                // Net changes are big; only the selected one is marked.
                if (c.category != "nets" || c == selected) {
                    const m = mark(
                        side == "a" ? c.board_a : c.board_b,
                        c,
                        true,
                    );
                    if (m && pcb.document) pcb_marks.push(m);
                }
            }
            if (sch.document) {
                sch.annotations = sch_marks;
                const nets =
                    selected && sch.document ? this.#nets(selected, side) : [];
                sch.highlight_nets(nets);
            }
            if (pcb.document) {
                pcb.annotations = pcb_marks;
                const keys = selected
                    ? side == "a"
                        ? selected.nets_a
                        : selected.nets_b
                    : [];
                pcb.highlight_nets(
                    selected?.category == "components" ? [] : keys,
                );
            }
        }
        this.#update_ghosts();
    }

    /**
     * In the highlight mode, A is shown (faintly) only where something was
     * removed: the "ghosts" of removed items.
     */
    #update_ghosts() {
        if (!this.#result) {
            return;
        }
        for (const kind of ["sch", "pcb"] as const) {
            const elm = kind == "sch" ? this.#sch_a : this.#pcb_a;
            const slot = elm.parentElement!;
            const viewer = elm.viewer;
            const rects: string[] = [];
            if (this.#mode == "highlight" && viewer?.document) {
                const boxes: BBox[] = [];
                for (const c of this.#visible_changes) {
                    if (c.kind != "removed") {
                        continue;
                    }
                    if (kind == "sch") {
                        for (const s of this.#symbols(c, "a")) {
                            const bb = this.#symbol_bbox(
                                viewer as SchematicViewer,
                                s,
                            );
                            if (bb) boxes.push(bb.copy().grow(0.6));
                        }
                    } else if (c.board_a && c.category != "nets") {
                        boxes.push(c.board_a.copy().grow(0.3));
                    }
                }
                const camera = viewer.viewport.camera;
                for (const bb of boxes) {
                    const p = camera.world_to_screen(bb.start);
                    const q = camera.world_to_screen(bb.end);
                    const x = Math.min(p.x, q.x);
                    const y = Math.min(p.y, q.y);
                    const w = Math.abs(q.x - p.x);
                    const h = Math.abs(q.y - p.y);
                    rects.push(`M${x} ${y}h${w}v${h}h${-w}Z`);
                }
            }
            slot.classList.toggle("ghosts", rects.length > 0);
            slot.style.clipPath = rects.length
                ? `path("${rects.join(" ")}")`
                : "";
        }
    }

    // Palettes

    #render_revisions() {
        const section = this.renderRoot.querySelector(".revisions")!;
        const option = (rev: string, label: string, selected: string) => {
            const o = document.createElement("option");
            o.value = rev;
            o.textContent = label;
            o.selected = rev == selected;
            return o;
        };
        const options = (selected: string) => [
            ...(this.#info?.dirty
                ? [option(WORKTREE, "Working copy (not committed)", selected)]
                : []),
            ...this.#commits.map((c) =>
                option(
                    c.sha,
                    `${c.short} · ${short_date(c.date)} · ${c.subject}`,
                    selected,
                ),
            ),
        ];
        const select_a = html`<select
            title="Revision A: the older state"></select>` as HTMLSelectElement;
        const select_b = html`<select
            title="Revision B: the state compared with A"></select>` as HTMLSelectElement;
        select_a.append(...options(this.#rev_a));
        select_b.append(...options(this.#rev_b));
        select_a.addEventListener("change", () => {
            this.#rev_a = select_a.value;
            this.#compare();
        });
        select_b.addEventListener("change", () => {
            this.#rev_b = select_b.value;
            this.#compare();
        });
        const swap = html`<button
            class="small"
            type="button"
            title="Swap A and B">
            ⇅ Swap
        </button>`;
        swap.addEventListener("click", () => {
            [this.#rev_a, this.#rev_b] = [this.#rev_b, this.#rev_a];
            this.#render_revisions();
            this.#compare();
        });
        const where = this.#info?.subdir
            ? `${this.#info.repository}/${this.#info.subdir}`
            : (this.#info?.repository ?? "");
        section.replaceChildren(
            html`<div class="form">
                <span class="rev-label a">A</span>
                ${select_a}
                <span class="rev-label b">B</span>
                ${select_b}
                <span></span>
                <div>${swap}</div>
                <span class="note"
                    >${this.#commits.length} commits change ${where}
                    ${this.#info?.branch
                        ? `(branch ${this.#info.branch})`
                        : ""}</span
                >
            </div>`,
        );
    }

    #render_tools() {
        const section = this.renderRoot.querySelector(".tools")!;
        const result = this.#result;
        if (!result) {
            return;
        }
        const count = (c: Category) =>
            result.changes.filter((x) => x.category == c).length;
        const rows = (["components", "nets", "layout"] as Category[]).map(
            (c) => {
                const box = html`<input type="checkbox" />` as HTMLInputElement;
                box.checked = this.#shown.has(c);
                box.addEventListener("change", () => {
                    if (box.checked) {
                        this.#shown.add(c);
                    } else {
                        this.#shown.delete(c);
                    }
                    if (
                        this.#selected &&
                        !this.#shown.has(this.#selected.category)
                    ) {
                        this.#selected = undefined;
                    }
                    this.#render_changes();
                    this.#render_sheets();
                    this.#update_marks();
                });
                return html`<div class="row">
                    <label>${box} ${category_names[c]}</label>
                    <span class="count">${count(c)}</span>
                </div>`;
            },
        );

        const opacity = html`<input
            type="range"
            min="0"
            max="100"
            value="50"
            title="Transparency of B over A" />` as HTMLInputElement;
        opacity.addEventListener("input", () =>
            this.style.setProperty(
                "--overlay-opacity",
                `${parseInt(opacity.value, 10) / 100}`,
            ),
        );

        const exports: [string, () => void][] = [
            ["Markdown", () => this.#export("md")],
            ["CSV", () => this.#export("csv")],
            ["JSON", () => this.#export("json")],
            ["BOM diff (Excel)", () => this.#export("bom")],
        ];

        section.replaceChildren(
            html`<h4>Show changes</h4>`,
            ...rows,
            html`<div class="row opacity-row">
                <label>B opacity ${opacity}</label>
            </div>`,
            html`<h4>Export</h4>`,
            html`<div class="buttons">
                ${exports.map(([label, fn]) => {
                    const b = html`<button class="small" type="button">
                        ${label}
                    </button>`;
                    b.addEventListener("click", fn);
                    return b;
                })}
            </div>`,
        );
        const row = this.renderRoot.querySelector<HTMLElement>(".opacity-row");
        if (row) {
            row.hidden = this.#mode != "overlay";
        }
    }

    #export(kind: "md" | "csv" | "json" | "bom") {
        const result = this.#result;
        const b = this.#project_b;
        if (!result || !b) {
            return;
        }
        const a_label = {
            id: this.#rev_a,
            label: this.#short_label(this.#rev_a),
        };
        const b_label = {
            id: this.#rev_b,
            label: this.#short_label(this.#rev_b),
        };
        const name =
            `${b.name || "project"}-${a_label.label}-${b_label.label}`.replace(
                /[^\w.-]+/g,
                "_",
            );
        switch (kind) {
            case "md":
                download_text(
                    `${name}.md`,
                    markdown_report(
                        b.name,
                        a_label,
                        b_label,
                        result,
                        this.#shown,
                    ),
                    "text/markdown",
                );
                break;
            case "csv":
                download_text(
                    `${name}.csv`,
                    changes_csv(result, this.#shown),
                    "text/csv",
                );
                break;
            case "json":
                download_text(
                    `${name}.json`,
                    json_report(b.name, a_label, b_label, result),
                    "application/json",
                );
                break;
            case "bom":
                download_text(`${name}-bom.csv`, bom_csv(result), "text/csv");
                break;
        }
    }

    #render_sheets() {
        const section = this.renderRoot.querySelector(".sheets");
        const a = this.#project_a;
        const b = this.#project_b;
        if (!section || !a || !b) {
            return;
        }
        const counts = new Map<string, number>();
        for (const c of this.#visible_changes) {
            for (const s of c.sheets) {
                counts.set(s, (counts.get(s) ?? 0) + 1);
            }
        }
        const pages = hierarchy_pages(b);
        const removed = hierarchy_pages(a).filter(
            (p) => !b.page_by_sheet_path(p.sheet_path),
        );
        const item = (page: ProjectPage, gone = false) => {
            const n = counts.get(page.sheet_path) ?? 0;
            const li = html`<li title="${page.filename}">
                <span class="text"
                    >${page.page ? `${page.page} · ` : ""}${page_name(
                        page,
                    )}${gone ? " (only in A)" : ""}</span
                >
                <span class="count">${n || ""}</span>
            </li>` as HTMLElement;
            li.classList.toggle("current", page.sheet_path == this.#sheet_path);
            li.addEventListener("click", () =>
                this.#show_sheet(page.sheet_path),
            );
            return li;
        };
        section.replaceChildren(
            html`<ul class="list">
                ${pages.map((p) => item(p))}
                ${removed.map((p) => item(p, true))}
            </ul>`,
        );
    }

    #render_changes() {
        const section = this.renderRoot.querySelector(".changes");
        const result = this.#result;
        if (!section || !result) {
            return;
        }
        const children: (Element | DocumentFragment)[] = [];
        for (const category of ["components", "nets", "layout"] as Category[]) {
            if (!this.#shown.has(category)) {
                continue;
            }
            const list = result.changes.filter((c) => c.category == category);
            children.push(
                html`<div class="group">
                    ${category_names[category]} (${list.length})
                </div>`,
            );
            if (!list.length) {
                children.push(html`<div class="row note">No changes</div>`);
                continue;
            }
            const ul = html`<ul class="list"></ul>` as HTMLElement;
            for (const c of list) {
                const li = html`<li
                    title="${[c.title, ...c.details].join("\n")}">
                    <span class="dot ${c.kind}"></span>
                    <span class="text"
                        >${c.title}
                        <span class="detail">${c.details.join(" · ")}</span>
                    </span>
                </li>` as HTMLElement;
                li.classList.toggle("selected", c == this.#selected);
                li.addEventListener("click", () =>
                    this.select_change(c == this.#selected ? undefined : c),
                );
                ul.append(li);
            }
            children.push(ul);
        }
        section.replaceChildren(...children);
        section
            .querySelector("li.selected")
            ?.scrollIntoView({ block: "nearest" });
    }

    /** Selects the change of a clicked part, if it has one. */
    #select_by_ref(ref: string | undefined) {
        if (!ref) {
            return;
        }
        const change = this.#visible_changes.find((c) => c.refs.includes(ref));
        if (change) {
            this.select_change(change, false);
        }
    }

    /** Shows a part (by reference) in both views. */
    async show_part(ref: string) {
        const b = this.#project_b;
        if (!b) {
            return;
        }
        for (const page of hierarchy_pages(b)) {
            for (const s of (page.document as KicadSch).symbols.values()) {
                if (reference_in(page, s) == ref) {
                    if (page.sheet_path != this.#sheet_path) {
                        await this.#show_sheet(page.sheet_path, false);
                    }
                    const bb = this.#symbol_bbox(this.#sch_b.viewer, s);
                    if (bb) {
                        this.#sch_b.viewer.zoom_to_item(bb);
                        this.#copy_camera(
                            this.#sch_b.viewer,
                            this.#sch_a.viewer,
                        );
                    }
                    const fp = this.#pcb_b.viewer.board?.find_footprint(ref);
                    if (fp) {
                        this.#pcb_b.viewer.zoom_to_item(fp.bbox);
                        this.#copy_camera(
                            this.#pcb_b.viewer,
                            this.#pcb_a.viewer,
                        );
                    }
                    this.#select_by_ref(ref);
                    return;
                }
            }
        }
    }

    // Setup

    override initialContentCallback() {
        // Keep A and B in sync.
        const pairs: [Viewer, Viewer][] = [
            [this.#sch_a.viewer, this.#sch_b.viewer],
            [this.#pcb_a.viewer, this.#pcb_b.viewer],
        ];
        (async () => {
            await Promise.all(
                [this.#sch_a, this.#sch_b, this.#pcb_a, this.#pcb_b].map(
                    (e) => e.ready,
                ),
            );
            const viewers = (elm: { viewer: Viewer }) => elm.viewer;
            const [sa, sb, pa, pb] = [
                this.#sch_a,
                this.#sch_b,
                this.#pcb_a,
                this.#pcb_b,
            ].map(viewers) as [
                SchematicViewer,
                SchematicViewer,
                BoardViewer,
                BoardViewer,
            ];
            for (const [x, y] of [
                [sa, sb],
                [pa, pb],
            ] as [Viewer, Viewer][]) {
                x.addEventListener(KiCanvasViewportEvent.type, () =>
                    this.#copy_camera(x, y),
                );
                y.addEventListener(KiCanvasViewportEvent.type, () =>
                    this.#copy_camera(y, x),
                );
            }
            void pairs;

            // Double click opens sheets in both revisions.
            for (const v of [sa, sb]) {
                v.addEventListener(KiCanvasActivateEvent.type, (e) => {
                    if (e.detail.item instanceof SchematicSheet) {
                        this.#show_sheet(
                            `${this.#sheet_path}/${e.detail.item.uuid}`,
                        );
                    }
                });
                v.addEventListener(KiCanvasSelectEvent.type, (e) => {
                    const item = e.detail.item;
                    const page = (
                        v == sa ? this.#project_a : this.#project_b
                    )?.page_by_sheet_path(this.#sheet_path);
                    if (item instanceof SchematicSymbol && page) {
                        this.#select_by_ref(reference_in(page, item));
                    }
                });
            }
            for (const v of [pa, pb]) {
                v.addEventListener(KiCanvasSelectEvent.type, (e) => {
                    if (e.detail.item instanceof Footprint) {
                        this.#select_by_ref(e.detail.item.reference);
                    }
                });
            }
            // The layers panel controls B; A follows.
            pb.addEventListener(KiCanvasLayersChangedEvent.type, () => {
                if (!pa.document || !pb.document) {
                    return;
                }
                for (const layer of pb.layers.in_order()) {
                    const other = pa.layers.by_name(layer.name);
                    if (other) {
                        other.visible = layer.visible;
                    }
                }
                if (pa.zone_fills != pb.zone_fills) {
                    pa.zone_fills = pb.zone_fills;
                }
                pa.draw();
            });
        })();

        const on_key = (e: KeyboardEvent) => {
            if (!this.#active || e.defaultPrevented) {
                return;
            }
            const typing = (e.composedPath()[0] as Element)?.closest?.(
                "input, textarea, select",
            );
            if (typing || e.ctrlKey || e.metaKey) {
                return;
            }
            const mode = modes[parseInt(e.key, 10) - 1];
            if (mode && !e.altKey) {
                this.mode = mode.mode;
            } else if (e.key.toLowerCase() == "z" && !e.altKey) {
                this.#step(e.shiftKey ? -1 : 1);
            } else if (e.key.toLowerCase() == "b" && !e.altKey) {
                this.mode = this.#mode == "blink" ? "highlight" : "blink";
            } else if (e.key == "Escape") {
                this.select_change(undefined);
            } else if (e.key == "Backspace" && e.altKey) {
                this.#on_button("leave_sheet");
            } else {
                return;
            }
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        // Not in the capture phase, so that e.g. an open chooser menu gets
        // Esc first.
        window.addEventListener("keydown", on_key);
        this.addDisposable({
            dispose: () => window.removeEventListener("keydown", on_key),
        });
    }

    override disconnectedCallback() {
        super.disconnectedCallback();
        window.clearInterval(this.#blink_timer);
    }

    override render() {
        const dark = (() => {
            try {
                return (
                    window.localStorage.getItem("kc:schematic-theme") != "light"
                );
            } catch {
                return true;
            }
        })();
        this.#sch_a =
            html`<kc-schematic-viewer></kc-schematic-viewer>` as KCSchematicViewerElement;
        this.#sch_b =
            html`<kc-schematic-viewer></kc-schematic-viewer>` as KCSchematicViewerElement;
        this.#sch_a.dark = dark;
        this.#sch_b.dark = dark;
        this.#pcb_a =
            html`<kc-board-viewer></kc-board-viewer>` as KCBoardViewerElement;
        this.#pcb_b =
            html`<kc-board-viewer></kc-board-viewer>` as KCBoardViewerElement;

        const slot = (side: "a" | "b", viewer: HTMLElement, what: string) =>
            html`<div class="slot ${side}">
                ${viewer}
                <div class="missing">Not in revision ${side.toUpperCase()}</div>
                <div class="tag ${side}">${side.toUpperCase()} · ${what}</div>
            </div>`;

        const left = html`<kc-ui-floating-panel
            heading="Compare"
            anchor="left"
            storage-key="compare-left">
            <kc-ui-floating-section name="revisions" heading="Revisions" open>
                <div class="revisions"></div>
            </kc-ui-floating-section>
            <kc-ui-floating-section name="tools" heading="Tools" open>
                <div class="tools"></div>
            </kc-ui-floating-section>
            <kc-ui-floating-section name="changes" heading="Changes" open>
                <div class="changes"></div>
            </kc-ui-floating-section>
            <kc-ui-floating-section name="sheets" heading="Sheets">
                <div class="sheets"></div>
            </kc-ui-floating-section>
        </kc-ui-floating-panel>` as KCUIFloatingPanelElement;

        const right = html`<kc-ui-floating-panel
            heading="Board"
            anchor="right"
            storage-key="compare-right"
            collapsed>
            <kc-ui-floating-section
                name="layers"
                heading="Layers (A and B)"
                open>
                <kc-board-appearance-panel></kc-board-appearance-panel>
            </kc-ui-floating-section>
        </kc-ui-floating-panel>` as KCUIFloatingPanelElement;

        return html`<div class="col sch">
                ${slot("a", this.#sch_a, "schematic")}
                <kc-ui-divider
                    horizontal
                    storage-key="compare-sch"></kc-ui-divider>
                ${slot("b", this.#sch_b, "schematic")} ${left}
            </div>
            <kc-ui-divider storage-key="compare"></kc-ui-divider>
            <div class="col pcb">
                ${slot("a", this.#pcb_a, "board")}
                <kc-ui-divider
                    horizontal
                    storage-key="compare-pcb"></kc-ui-divider>
                ${slot("b", this.#pcb_b, "board")} ${right}
            </div>
            <div class="message" hidden></div>`;
    }
}

window.customElements.define("kc-compare-workspace", KCCompareWorkspaceElement);
