/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { later } from "../../base/async";
import { DropTarget } from "../../base/dom/drag-drop";
import { FilePicker } from "../../base/dom/file-picker";
import { CSS, attribute, html, query } from "../../base/web-components";
import { KCUIElement, KCUIIconElement } from "../../kc-ui";
import { sprites_url } from "../icons/sprites";
import type { BoardViewer } from "../../viewers/board/viewer";
import type { SchematicViewer } from "../../viewers/schematic/viewer";
import { Footprint, KicadPCB } from "../../kicad/board";
import { SchematicSymbol } from "../../kicad/schematic";
import {
    KiCanvasLoadEvent,
    KiCanvasMouseMoveEvent,
    KiCanvasNetSelectEvent,
    KiCanvasSelectEvent,
} from "../../viewers/base/events";
import { CrossProbe, CrossProbeIndex } from "../cross-probe";
import { PartInfo } from "../part-info";
import { Project, type ProjectPage } from "../project";
import { KCPartInfoElement } from "./common/part-info";
import { KCSearchBoxElement } from "./common/search-box";
import { build_search_items, type SearchItem } from "../search";
import { decode_view, encode_view, type ViewState } from "../share";
import {
    WORKTREE,
    git_commits,
    git_info,
    revision_fs,
    type Commit,
} from "../compare/revisions";
import { KCRevisionListElement } from "./common/revision-list";
import type { KCUIFloatingPanelElement } from "../../kc-ui";
import {
    KCCompareWorkspaceElement,
    type CompareMode,
} from "./compare/compare-workspace";
import { KCUIDividerElement } from "../../kc-ui";
import { GitHubFileSystem } from "../services/github-vfs";
import { CodebergFileSystem } from "../services/codeberg-vfs";
import { FetchFileSystem, type IFileSystem } from "../services/vfs";
import { KCBoardAppElement } from "./kc-board/app";
import { KCSchematicAppElement } from "./kc-schematic/app";

import kc_ui_styles from "../../kc-ui/kc-ui.css";
import shell_styles from "./kicanvas-shell.css";

import "../icons/sprites";
import "./common/project-panel";

// Setup KCUIIconElement to use icon sprites.
KCUIIconElement.sprites_url = sprites_url;

/**
 * <kc-kicanvas-shell> is the main entrypoint for the standalone KiCanvas
 * application: It's the thing you see when you go to kicanvas.org.
 *
 * The shell is responsible for managing the currently loaded Project and
 * switching between the different viewer apps (<kc-schematic-app>,
 * <kc-board-app>).
 *
 * This is a simplified version of the subtree:
 *
 * <kc-kicanvas-shell>
 *   <kc-ui-app>
 *     <kc-project-panel>
 *     <kc-schematic-app>
 *       <kc-schematic-viewer>
 *       <kc-ui-activity-side-bar>
 *     <kc-board-app>
 *       <kc-board-viewer>
 *       <kc-ui-activity-side-bar>
 *
 */
class KiCanvasShellElement extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        // TODO: Find a better way to handle these two styles.
        new CSS(kc_ui_styles),
        new CSS(shell_styles),
    ];

    project: Project = new Project();

    #schematic_app: KCSchematicAppElement;
    #board_app: KCBoardAppElement;
    #cross_probe?: CrossProbe;
    #part_info: KCPartInfoElement;
    #search: KCSearchBoxElement;
    #index?: CrossProbeIndex;
    #workspace_listeners: { dispose(): void }[] = [];
    /** Where the user last pressed the pointer, relative to <main> */
    #last_pointer = { x: 0, y: 0 };

    /** Hints set by tools (search, measure), which take precedence. */
    #tool_hints = new Map<string, string>();

    /** Fired (on window) by tools to set or clear their hint. */
    static hint_event = "kicanvas:hint";

    static default_hint =
        "Scroll: zoom · Middle drag or Shift/Ctrl+scroll: pan · Click: select a part, net or bus · Double click: open sheet";

    /** Updates the one line hint at the bottom of the page. */
    #update_hint() {
        const elm = this.renderRoot.querySelector("main .status .hint");
        if (!elm) {
            return;
        }

        let text = [...this.#tool_hints.values()].at(-1);

        if (!text) {
            const card = this.#part_info;
            const bv = this.#board_app?.viewer as BoardViewer | undefined;
            const sv = this.#schematic_app?.viewer as
                | SchematicViewer
                | undefined;
            const keys = this.#cross_probe?.net_keys ?? [];
            const board_nets = bv?.highlighted_nets ?? [];
            const named = keys.filter((k) => !k.startsWith("#"));
            if (card?.open && card.info) {
                text = `${card.info.reference} selected · Click elsewhere or Esc to clear`;
            } else if (keys.length > 1 || board_nets.length > 1) {
                text = `${Math.max(keys.length, board_nets.length)} nets highlighted on all sheets · Esc to clear`;
            } else if (named.length == 1) {
                text = `Net ${named[0]} highlighted on all sheets · Double click a sheet to follow it · Esc to clear`;
            } else if (board_nets.length == 1) {
                text = `Net ${bv!.board.get_netname_by_number(board_nets[0]!)} highlighted · Esc to clear`;
            } else if (keys.length || sv?.highlighted_nets.length) {
                text = "Net highlighted · Esc to clear";
            }
        }

        text ??= KiCanvasShellElement.default_hint;
        if (this.#revision != WORKTREE && !this.#compare?.active) {
            text = `Revision ${this.#revision_label()} · ${text}`;
        }
        elm.textContent = text;
    }

    /**
     * Places the row with the search box and the views' buttons at the top
     * of the divider, or in the middle if there's only one view.
     */
    #position_bar() {
        const main = this.renderRoot.querySelector("main");
        const left = this.renderRoot.querySelector<HTMLElement>("main > .left");
        const bar =
            this.renderRoot.querySelector<HTMLElement>("main > .center-bar");
        if (!main || !bar) {
            return;
        }
        let x =
            this.#compare?.active && this.#compare.split_x
                ? this.#compare.split_x + 3
                : this.has_schematic && this.has_board && left
                  ? left.offsetWidth + 3
                  : main.clientWidth / 2;
        // Keep it in the window.
        const half = bar.offsetWidth / 2;
        x = Math.max(half + 4, Math.min(x, main.clientWidth - half - 4));
        bar.style.left = `${x}px`;

        // The revision palette starts below the Compare button.
        const panel = this.#revision_panel;
        const compare = bar.querySelector<HTMLElement>("button[name=compare]");
        if (panel && !panel.hidden && !panel.placed && compare) {
            const r = compare.getBoundingClientRect();
            const m = main.getBoundingClientRect();
            panel.move_to(
                r.left + r.width / 2 - m.left - panel.offsetWidth / 2,
                r.bottom - m.top + 6,
            );
        }
    }

    /** Shows a part or net picked in the search box in both views. */
    #on_search_pick(item: SearchItem) {
        if (this.#compare?.active) {
            if (item.kind == "part") {
                this.#compare.show_part(item.reference);
            }
            return;
        }
        const sv = this.project.has_schematics
            ? (this.#schematic_app.viewer as SchematicViewer)
            : undefined;
        const bv = this.project.has_boards
            ? (this.#board_app.viewer as BoardViewer)
            : undefined;

        if (item.kind == "net") {
            this.#part_info.hide();
            if (this.#cross_probe) {
                this.#cross_probe.probe_net(item.name);
            } else if (bv) {
                bv.highlight_net(item.name);
                const bbox = bv.net_bbox(item.name);
                if (bbox.valid) {
                    bv.zoom_to_item(bbox);
                }
            }
            window.setTimeout(() => this.#update_hint());
            return;
        }

        if (item.footprint && this.#cross_probe) {
            this.#cross_probe.probe_part(item.footprint);
            return;
        }
        if (item.footprint && bv) {
            bv.select(item.footprint);
            bv.zoom_to_item(item.footprint.bbox);
            return;
        }

        // A part that's only in the schematic.
        const { page, symbol } = item;
        if (sv && page && symbol) {
            const show = () => {
                sv.select(symbol);
                if (sv.selected) {
                    sv.zoom_to_item(sv.selected);
                }
            };
            if (this.#schematic_app.current_page == page) {
                show();
            } else {
                const once = sv.addEventListener(KiCanvasLoadEvent.type, () => {
                    once.dispose();
                    show();
                });
                this.project.set_active_page(page);
            }
        }
    }

    /** Clears the selection and highlights in both views. */
    #clear_selection() {
        if (this.project.has_boards) {
            (this.#board_app.viewer as BoardViewer | undefined)?.select(null);
        }
        if (this.project.has_schematics) {
            (this.#schematic_app.viewer as SchematicViewer | undefined)?.select(
                null,
            );
        }
        this.#part_info.hide();
        this.#update_hint();
    }

    #schematic_viewer() {
        return this.project.has_schematics
            ? (this.#schematic_app.viewer as SchematicViewer | undefined)
            : undefined;
    }

    #board_viewer() {
        return this.project.has_boards
            ? (this.#board_app.viewer as BoardViewer | undefined)
            : undefined;
    }

    /** What's shown now, for a shared link. */
    #view_state(): ViewState {
        if (this.#compare?.active) {
            return { compare: this.#compare.state };
        }
        const sv = this.#schematic_viewer();
        const bv = this.#board_viewer();
        const state: ViewState = {};
        if (this.#revision != WORKTREE) {
            state.rev = this.#revision;
        }
        if (sv?.document) {
            state.sheet = this.#schematic_app.current_page?.project_path;
            state.sch = sv.viewport.camera.bbox;
        }
        if (bv?.document) {
            state.board = bv.viewport.camera.bbox;
            state.flip = bv.viewport.camera.flipped;
        }
        const cp = this.#cross_probe;
        if (cp?.part) {
            state.part = cp.part.reference;
        } else if (cp?.net_keys.length) {
            state.nets = [...cp.net_keys];
        } else if (bv?.highlighted_nets.length) {
            state.nets = bv.highlighted_nets.map(
                (n) => bv.board.get_netname_by_number(n) ?? "",
            );
        } else if (bv?.selected?.context instanceof Footprint) {
            state.part = bv.selected.context.reference;
        }
        return state;
    }

    /**
     * Copies a link to the current view (sheet, zoom, selection and
     * highlighted nets) and puts it in the address bar.
     */
    async #share() {
        const url = new URL(window.location.href);
        url.hash = encode_view(this.#view_state());
        window.history.replaceState(null, "", url);

        const button = this.renderRoot.querySelector<HTMLElement>(
            "main .center-bar button[name=share]",
        )!;
        if (await copy_text(url.href)) {
            // Just confirm it on the button for a moment.
            button.setAttribute("copied", "");
            window.clearTimeout(this.#share_timer);
            this.#share_timer = window.setTimeout(
                () => button.removeAttribute("copied"),
                2000,
            );
            return;
        }

        // No clipboard access at all: show the link to copy by hand.
        const popup = this.renderRoot.querySelector<HTMLElement>(
            "main .center-bar .share-popup",
        )!;
        const input = popup.querySelector("input")!;
        popup.querySelector(".msg")!.textContent = "Copy this link:";
        input.value = url.href;
        popup.hidden = false;
        input.focus();
        input.select();

        const close = (e?: Event) => {
            if (e && e.composedPath().includes(popup)) {
                return;
            }
            popup.hidden = true;
            window.removeEventListener("pointerdown", close, true);
            window.removeEventListener("keydown", on_key, true);
        };
        const on_key = (e: KeyboardEvent) => {
            if (e.key == "Escape" || e.key == "Enter") {
                e.preventDefault();
                e.stopImmediatePropagation();
                close();
            }
        };
        window.addEventListener("pointerdown", close, true);
        window.addEventListener("keydown", on_key, true);
    }

    #share_timer = 0;

    #started = false;

    /** The revision shown: a commit's SHA, or the working copy. */
    #revision = WORKTREE;
    #commits: Commit[] = [];

    get #revision_panel() {
        return this.renderRoot.querySelector<KCUIFloatingPanelElement>(
            "main > kc-ui-floating-panel.revision",
        );
    }

    #revision_label(rev = this.#revision) {
        if (rev == WORKTREE) {
            return "working copy";
        }
        const c = this.#commits.find((c) => c.sha == rev);
        return c ? `${c.short} · ${c.date.slice(0, 10)}` : rev.slice(0, 7);
    }

    /** Shows the revision palette if the project has git history. */
    async #setup_history() {
        const info = await git_info();
        if (!info.available) {
            return;
        }
        try {
            this.#commits = await git_commits();
        } catch {
            return;
        }
        const panel = this.#revision_panel;
        if (!panel) {
            return;
        }
        panel
            .querySelector<KCRevisionListElement>("kc-revision-list")!
            .set_history(info, this.#commits, this.#revision);
        panel.set_heading(`Revision · ${this.#revision_label()}`);
        panel.hidden = false;
        window.requestAnimationFrame(() => this.#position_bar());
    }

    /**
     * Shows the project at another revision, keeping what's shown (sheet,
     * zoom, selection and the board's layers) or showing the given view.
     */
    async #show_revision(rev: string, view?: ViewState) {
        if (rev == this.#revision && !view) {
            return;
        }
        const state = view ?? this.#view_state();
        state.rev = undefined;
        state.compare = undefined;

        const bv = this.#board_viewer();
        const layers = bv?.document
            ? {
                  visible: [...bv.layers.in_order()]
                      .filter((l) => l.visible)
                      .map((l) => l.name),
                  zone_fills: bv.zone_fills,
              }
            : undefined;

        let fs;
        try {
            fs = await revision_fs(rev);
        } catch (e) {
            console.error(e);
            return;
        }

        this.loading = true;
        try {
            await this.project.load(fs);
        } catch (e) {
            console.error(e);
            this.loading = false;
            return;
        }
        this.#revision = rev;
        this.has_schematic = this.project.has_schematics;
        this.has_board = this.project.has_boards;

        // Show the same sheet (if the revision has it) and the board.
        const shown = (
            app: KCSchematicAppElement | KCBoardAppElement,
            page: ProjectPage | undefined,
        ) => {
            const viewer = page && app.viewer;
            if (!viewer) {
                return null;
            }
            return new Promise<void>((resolve) => {
                const once = viewer.addEventListener(
                    KiCanvasLoadEvent.type,
                    () => {
                        once.dispose();
                        resolve();
                    },
                );
                app.load(page);
            });
        };
        const sheet =
            (state.sheet && this.project.page_by_path(state.sheet)) ||
            this.project.root_schematic_page;
        const board = [...this.project.pages()].find((p) => p.type == "pcb");
        await Promise.race([
            Promise.all([
                shown(this.#schematic_app, sheet),
                shown(this.#board_app, board),
            ]),
            new Promise((r) => window.setTimeout(r, 30000)),
        ]);
        this.loading = false;
        this.loaded = true;
        await this.#setup_workspace();

        const nbv = this.#board_viewer();
        if (layers && nbv?.document) {
            for (const layer of nbv.layers.in_order()) {
                layer.visible = layers.visible.includes(layer.name);
            }
            nbv.zone_fills = layers.zone_fills;
        }
        await this.#restore_view(state);

        const panel = this.#revision_panel;
        if (panel) {
            panel.querySelector<KCRevisionListElement>(
                "kc-revision-list",
            )!.current = rev;
            panel.set_heading(`Revision · ${this.#revision_label()}`);
        }
        this.#update_hint();
    }

    #compare?: KCCompareWorkspaceElement;

    /** Switches between viewing and comparing revisions. */
    async #toggle_compare(revisions?: {
        a: string;
        b: string;
        mode?: CompareMode;
    }) {
        const button = this.renderRoot.querySelector<HTMLElement>(
            "main .center-bar button[name=compare]",
        )!;
        const tools = (side: string) =>
            this.renderRoot.querySelector(
                `main .center-bar .tools.${side} .set.compare`,
            )!;

        if (this.#compare?.active) {
            this.#compare.leave();
            this.comparing = false;
            button.removeAttribute("selected");
            this.#position_bar();
            this.#update_hint();
            return;
        }

        if (!this.#compare) {
            this.#compare =
                html`<kc-compare-workspace></kc-compare-workspace>` as KCCompareWorkspaceElement;
            this.renderRoot.querySelector("main")!.append(this.#compare);
            // Both sets of buttons stay in the row; CSS shows one of them.
            // (Moving the buttons around would render them again.)
            tools("left").replaceChildren(...this.#compare.toolbar_left);
            tools("right").replaceChildren(...this.#compare.toolbar_right);
        }
        // Compare the shown revision with the one before it.
        if (!revisions && this.#revision != WORKTREE) {
            const i = this.#commits.findIndex((c) => c.sha == this.#revision);
            const before = this.#commits[i + 1];
            if (i >= 0 && before) {
                revisions = { a: before.sha, b: this.#revision };
            }
        }
        this.#part_info.hide();
        this.comparing = true;
        button.setAttribute("selected", "");
        window.requestAnimationFrame(() => this.#position_bar());
        await this.#compare.enter(revisions);
        this.#position_bar();
    }

    /** Comparing revisions (see #toggle_compare). */
    @attribute({ type: Boolean })
    public comparing: boolean;

    /** Shows the view from a shared link, see #share(). */
    async #restore_view(state: ViewState) {
        const sv = this.#schematic_viewer();
        const bv = this.#board_viewer();
        await Promise.all([sv?.loaded, bv?.loaded]);

        if (state.compare) {
            await this.#toggle_compare(state.compare);
            return;
        }

        // The sheet first, then the selection, then the zoom (which the
        // selection would change).
        const page = state.sheet
            ? this.project.page_by_path(state.sheet)
            : undefined;
        if (sv && page && this.#schematic_app.current_page != page) {
            await new Promise<void>((resolve) => {
                const once = sv.addEventListener(KiCanvasLoadEvent.type, () => {
                    once.dispose();
                    resolve();
                });
                this.project.set_active_page(page);
            });
        }

        const fp = state.part
            ? bv?.board.find_footprint(state.part)
            : undefined;
        if (fp && bv) {
            // Show the part's card in the middle of the board.
            const right =
                this.renderRoot.querySelector<HTMLElement>("main > .right");
            if (right) {
                this.#last_pointer = {
                    x: right.offsetLeft + right.offsetWidth / 2,
                    y: right.offsetHeight / 2,
                };
            }
            if (this.#cross_probe) {
                this.#cross_probe.show_part(fp);
            } else {
                bv.select(fp);
            }
        } else if (state.nets?.length) {
            if (this.#cross_probe) {
                this.#cross_probe.show_nets(state.nets);
            } else {
                bv?.highlight_nets(state.nets);
            }
        }

        // Wait for the views to have their final size.
        await new Promise((r) => window.setTimeout(r, 100));
        if (bv && state.flip != bv.viewport.camera.flipped) {
            bv.flip_view();
            const flip = this.#board_app.button("flip_view");
            if (flip) {
                flip.selected = bv.viewport.camera.flipped;
            }
        }
        for (const [viewer, bbox] of [
            [sv, state.sch],
            [bv, state.board],
        ] as const) {
            if (viewer && bbox) {
                viewer.viewport.camera.bbox = bbox;
                viewer.viewport.user_moved_camera = true;
                viewer.draw();
            }
        }
        this.#update_hint();
    }

    constructor() {
        super();
        this.provideContext("project", this.project);
    }

    @attribute({ type: Boolean })
    public loading: boolean;

    @attribute({ type: Boolean })
    public loaded: boolean;

    @attribute({ type: String })
    public src: string;

    /** The loaded project has schematics (shown in the left pane). */
    @attribute({ type: Boolean })
    public has_schematic: boolean;

    /** The loaded project has a board (shown in the right pane). */
    @attribute({ type: Boolean })
    public has_board: boolean;

    @query(`input[name="link"]`, true)
    public link_input: HTMLInputElement;

    @query(`button[name="open_local"]`, true)
    public open_file_button: HTMLButtonElement;

    override initialContentCallback() {
        // The hint line: tools set theirs with a hint event, and it follows
        // the selection otherwise.
        const on_hint = (e: Event) => {
            const { source, text } = (
                e as CustomEvent<{ source: string; text: string | null }>
            ).detail;
            this.#tool_hints.delete(source);
            if (text) {
                this.#tool_hints.set(source, text);
            }
            this.#update_hint();
        };
        window.addEventListener(KiCanvasShellElement.hint_event, on_hint);
        this.addDisposable({
            dispose: () =>
                window.removeEventListener(
                    KiCanvasShellElement.hint_event,
                    on_hint,
                ),
        });

        this.addEventListener(KCPartInfoElement.hidden_event, () =>
            this.#update_hint(),
        );

        // Buttons change width once the icon font is loaded.
        document.fonts?.ready.then(() => this.#position_bar());

        // The search box and buttons sit at the top end of the divider.
        const workspace = this.renderRoot.querySelector("main")!;
        workspace.addEventListener(KCUIDividerElement.resize_event, () =>
            this.#position_bar(),
        );
        new ResizeObserver(() => this.#position_bar()).observe(workspace);
        workspace.addEventListener(KCSearchBoxElement.pick_event, (e) =>
            this.#on_search_pick((e as CustomEvent<SearchItem>).detail),
        );
        workspace.addEventListener(KCRevisionListElement.pick_event, (e) =>
            this.#show_revision((e as CustomEvent<string>).detail),
        );

        const share = this.renderRoot.querySelector(
            "main .center-bar button[name=share]",
        )!;
        share.addEventListener("click", () => this.#share());
        this.renderRoot
            .querySelector("main .center-bar button[name=compare]")!
            .addEventListener("click", () => this.#toggle_compare());

        workspace.addEventListener(KCSearchBoxElement.focus_event, (e) => {
            const focused = (e as CustomEvent<boolean>).detail;
            window.dispatchEvent(
                new CustomEvent(KiCanvasShellElement.hint_event, {
                    detail: {
                        source: "search",
                        text: focused
                            ? "Type 2+ characters: reference, ID, MPN or net name · ↑↓ and Enter: pick · Esc: close"
                            : null,
                    },
                }),
            );
        });

        // Esc clears the selection, unless a tool uses it.
        const on_key = (e: KeyboardEvent) => {
            const typing = (e.composedPath()[0] as Element)?.closest?.(
                "input, textarea",
            );
            if (e.key == "/" && this.loaded && !typing) {
                e.preventDefault();
                this.#search.focus();
                return;
            }
            // Like KiCad's "Leave Sheet".
            if (
                e.key == "Backspace" &&
                e.altKey &&
                this.loaded &&
                this.has_schematic &&
                !typing
            ) {
                e.preventDefault();
                this.#schematic_app.leave_sheet();
                return;
            }
            if (
                e.key == "Escape" &&
                this.loaded &&
                !this.#tool_hints.size &&
                !e.defaultPrevented
            ) {
                this.#clear_selection();
            }
        };
        window.addEventListener("keydown", on_key);
        this.addDisposable({
            dispose: () => window.removeEventListener("keydown", on_key),
        });

        // Remember where parts are clicked, to show their info there.
        const main = this.renderRoot.querySelector("main")!;
        main.addEventListener(
            "pointerdown",
            (e) => {
                const rect = main.getBoundingClientRect();
                this.#last_pointer = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top,
                };
            },
            true,
        );

        const url_params = new URLSearchParams(document.location.search);

        const urls = [
            ...url_params.getAll("github"),
            ...url_params.getAll("repo"),
        ];

        // Only load the first URL
        const url = urls[0];

        // Files to load: the src attribute (space separated) and ?src=
        // parameters, e.g. ?src=board.kicad_pcb&src=board.kicad_sch
        const srcs = [
            ...(this.src?.split(/\s+/).filter(Boolean) ?? []),
            ...url_params.getAll("src"),
        ];

        later(async () => {
            if (srcs.length) {
                const vfs = new FetchFileSystem(srcs);
                await this.setup_project(vfs);
                return;
            }

            if (url) {
                const vfs = await this.load_repo(url);
                if (!vfs) {
                    return;
                }

                await this.setup_project(vfs);
                return;
            }

            new DropTarget(this, async (fs) => {
                await this.setup_project(fs);
            });
        });

        this.link_input.addEventListener("input", async (e) => {
            const link = this.link_input.value;
            const vfs = await this.load_repo(link);

            if (!vfs) {
                // TODO: show error message: invaild URL
                console.error(`Invalid URL: ${link}`);
                return;
            }

            await this.setup_project(vfs);

            const location = new URL(window.location.href);
            location.searchParams.set("repo", link);
            window.history.pushState(null, "", location);
        });

        this.open_file_button.addEventListener("click", async (e) => {
            FilePicker.pick(async (vfs) => {
                await this.setup_project(vfs);
            });
        });
    }

    private async load_repo(url: string): Promise<IFileSystem | null> {
        return (
            (await GitHubFileSystem.fromURLs(url)) ??
            (await CodebergFileSystem.fromURLs(url))
        );
    }

    private async setup_project(vfs: IFileSystem) {
        this.loaded = false;
        this.loading = true;

        try {
            await vfs.setup();
            await this.project.load(vfs);
            this.has_schematic = this.project.has_schematics;
            this.has_board = this.project.has_boards;
            this.project.set_active_page(this.project.first_page);
            this.loaded = true;
            this.#setup_workspace();
        } catch (e) {
            console.error(e);
        } finally {
            this.loading = false;
        }
    }

    /**
     * Sets up the things that work across both views: cross-probing and
     * the part info card.
     */
    async #setup_workspace() {
        this.#cross_probe?.dispose();
        this.#cross_probe = undefined;
        this.#index = undefined;
        for (const l of this.#workspace_listeners) {
            l.dispose();
        }
        this.#workspace_listeners = [];
        this.#part_info.hide();

        const has_schematics = this.project.has_schematics;
        const has_boards = this.project.has_boards;

        await Promise.all([
            has_schematics ? this.#schematic_app.viewerReady : null,
            has_boards ? this.#board_app.viewerReady : null,
        ]);

        const sv = has_schematics
            ? (this.#schematic_app.viewer as SchematicViewer)
            : undefined;
        const bv = has_boards
            ? (this.#board_app.viewer as BoardViewer)
            : undefined;

        // Cross-probing must be set up first: its listeners have to run
        // before the part info card's, see below.
        if (sv && bv) {
            this.#cross_probe = new CrossProbe(
                this.project,
                sv,
                bv,
                () => this.#schematic_app.current_page,
            );
        }

        const index = () => {
            if (!this.#index) {
                const board = first_board(this.project);
                if (board) {
                    this.#index = new CrossProbeIndex(this.project, board);
                }
            }
            return this.#index;
        };

        // Search: everything in the project.
        this.#search.items = build_search_items(
            this.project,
            first_board(this.project),
            index(),
        );

        // The views' buttons go next to the search box: the schematic's on
        // its left, the board's on its right.
        const group = (side: string) =>
            this.renderRoot.querySelector(`main .center-bar .tools.${side}`)!;
        const fill = (side: string, buttons: readonly HTMLElement[]) => {
            const set = group(side).querySelector(".set.view")!;
            const same =
                set.children.length == buttons.length &&
                buttons.every((b, i) => set.children[i] == b);
            if (!same) {
                set.replaceChildren(...buttons);
            }
        };
        fill("left", has_schematics ? this.#schematic_app.toolbar_buttons : []);
        fill(
            "right",
            has_boards ? [...this.#board_app.toolbar_buttons].reverse() : [],
        );
        group("left").toggleAttribute("hidden", !has_schematics);
        group("right").toggleAttribute("hidden", !has_boards);
        this.#position_bar();
        window.requestAnimationFrame(() => this.#position_bar());

        // The board's coordinates are shown in the status line.
        const coords = this.renderRoot.querySelector("main .status .coords")!;
        coords.textContent = "";
        if (bv) {
            this.#workspace_listeners.push(
                bv.addEventListener(KiCanvasMouseMoveEvent.type, () => {
                    const p = bv.mouse_position;
                    coords.textContent = `X ${p.x.toFixed(2)}  Y ${p.y.toFixed(2)} mm`;
                }),
            );
        }

        // Keep the hint line in sync with the selection, after the card and
        // cross-probing have reacted.
        const later_hint = () => window.setTimeout(() => this.#update_hint());
        for (const v of [sv, bv]) {
            if (v) {
                this.#workspace_listeners.push(
                    v.addEventListener(KiCanvasSelectEvent.type, later_hint),
                    v.addEventListener(KiCanvasNetSelectEvent.type, later_hint),
                );
            }
        }
        this.#update_hint();

        // Show the part info card for the clicked part. When cross-probing
        // selects the part in the other view too, the card just stays.
        const card = this.#part_info;
        if (sv) {
            this.#workspace_listeners.push(
                sv.addEventListener(KiCanvasSelectEvent.type, (e) => {
                    const item = e.detail.item;
                    const page = this.#schematic_app.current_page;
                    if (
                        item instanceof SchematicSymbol &&
                        !item.lib_symbol.power &&
                        page
                    ) {
                        card.show(
                            PartInfo.from_symbol(
                                page,
                                item,
                                index()?.footprint_for(page, item),
                            ),
                            this.#last_pointer,
                        );
                    } else {
                        card.hide();
                    }
                }),
                sv.addEventListener(KiCanvasNetSelectEvent.type, () =>
                    card.hide(),
                ),
            );
        }
        if (bv) {
            this.#workspace_listeners.push(
                bv.addEventListener(KiCanvasSelectEvent.type, (e) => {
                    const item = e.detail.item;
                    if (item instanceof Footprint) {
                        const placement = index()?.symbols_for(item)[0];
                        card.show(
                            placement
                                ? PartInfo.from_symbol(
                                      placement.page,
                                      placement.symbol,
                                      item,
                                  )
                                : PartInfo.from_footprint(item),
                            this.#last_pointer,
                        );
                    } else {
                        card.hide();
                    }
                }),
                bv.addEventListener(KiCanvasNetSelectEvent.type, () =>
                    card.hide(),
                ),
            );
        }

        // Only once, not after showing another revision.
        if (!this.#started) {
            this.#started = true;
            this.#setup_history();

            // Opened from a shared link.
            const shared = decode_view(window.location.hash);
            const restore = shared?.rev
                ? this.#show_revision(shared.rev, shared)
                : shared
                  ? this.#restore_view(shared)
                  : null;
            restore?.catch((e) =>
                console.error("Couldn't restore the shared view", e),
            );
        }
    }

    override render() {
        this.#part_info =
            html`<kc-part-info></kc-part-info>` as KCPartInfoElement;
        this.#search =
            html`<kc-search-box></kc-search-box>` as KCSearchBoxElement;

        this.#schematic_app = html`
            <kc-schematic-app controls="floating"></kc-schematic-app>
        ` as KCSchematicAppElement;
        this.#board_app = html`
            <kc-board-app controls="floating"></kc-board-app>
        ` as KCBoardAppElement;

        return html`
            <kc-ui-app>
                <section class="overlay">
                    <h1>
                        <img src="images/kicanvas.png" />
                        KiCanvas
                    </h1>
                    <p>
                        KiCanvas is an
                        <strong>interactive</strong>
                        ,
                        <strong>browser-based</strong>
                        viewer for KiCad schematics and boards. You can learn
                        more from the
                        <a href="https://kicanvas.org/home" target="_blank"
                            >docs</a
                        >. It's in
                        <strong>alpha</strong>
                        so please
                        <a
                            href="https://github.com/theacodes/kicanvas/issues/new/choose"
                            target="_blank">
                            report any bugs</a
                        >!
                    </p>
                    <input
                        name="link"
                        type="text"
                        placeholder="Paste a GitHub/Codeberg link..."
                        autofocus />
                    <p>
                        or drag & drop your KiCad files, or<button
                            name="open_local"
                            class="link_button">
                            open from local
                        </button>
                    </p>
                    <p class="note">
                        KiCanvas is
                        <a
                            href="https://github.com/theacodes/kicanvas"
                            target="_blank"
                            >free & open source</a
                        >
                        and supported by
                        <a
                            href="https://github.com/theacodes/kicanvas#special-thanks"
                            >community donations</a
                        >
                        with significant support from
                        <a href="https://partsbox.com/" target="_blank"
                            >PartsBox</a
                        >,
                        <a href="https://blues.io/" target="_blank">Blues</a>,
                        <a href="https://blog.mithis.net/" target="_blank"
                            >Mithro</a
                        >,
                        <a href="https://github.com/jeremysf">Jeremy Gordon</a>,
                        &
                        <a href="https://github.com/jamesneal" target="_blank"
                            >James Neal</a
                        >. KiCanvas runs entirely within your browser, so your
                        files don't ever leave your machine.
                    </p>
                    <p class="github">
                        <a
                            href="https://github.com/theacodes/kicanvas"
                            target="_blank"
                            title="Visit on GitHub">
                            <img src="images/github-mark-white.svg" />
                        </a>
                    </p>
                </section>
                <main>
                    <div class="pane left">${this.#schematic_app}</div>
                    <kc-ui-divider storage-key="workspace"></kc-ui-divider>
                    <div class="pane right">${this.#board_app}</div>
                    ${this.#part_info}
                    <div class="center-bar">
                        <div class="tools left">
                            <span class="set view"></span>
                            <span class="set compare"></span>
                        </div>
                        <div class="middle">
                            ${this.#search}
                            <div class="actions">
                                <button
                                    type="button"
                                    class="pill"
                                    name="share"
                                    title="Copy a link to the clipboard that opens this view: sheet, zoom and highlight">
                                    <kc-ui-icon>share</kc-ui-icon>
                                    <span class="label">Share</span>
                                    <span class="done">Link copied</span>
                                </button>
                                <button
                                    type="button"
                                    class="pill"
                                    name="compare"
                                    title="Compare two revisions from the project's git history (click again to go back)">
                                    <kc-ui-icon>compare_arrows</kc-ui-icon>
                                    Compare
                                </button>
                            </div>
                            <div class="share-popup" hidden>
                                <span class="msg"></span>
                                <input type="text" readonly />
                            </div>
                        </div>
                        <div class="tools right">
                            <span class="set view"></span>
                            <span class="set compare"></span>
                        </div>
                    </div>
                    <kc-ui-floating-panel
                        class="revision"
                        heading="Revision"
                        storage-key="revision"
                        collapsed
                        hidden>
                        <kc-revision-list></kc-revision-list>
                    </kc-ui-floating-panel>
                    <div class="status" role="status">
                        <span class="hint"></span>
                        <span class="coords"></span>
                    </div>
                </main>
            </kc-ui-app>
        `;
    }
}

/**
 * Puts text on the clipboard. The Clipboard API needs a secure context
 * (https or localhost); otherwise the old "copy" command still works.
 */
async function copy_text(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Try the old way.
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
        ok = document.execCommand("copy");
    } catch {
        ok = false;
    }
    area.remove();
    return ok;
}

function first_board(project: Project): KicadPCB | undefined {
    for (const board of project.boards()) {
        return board;
    }
    return undefined;
}

window.customElements.define("kc-kicanvas-shell", KiCanvasShellElement);
