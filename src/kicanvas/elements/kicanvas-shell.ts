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
    KiCanvasNetSelectEvent,
    KiCanvasSelectEvent,
} from "../../viewers/base/events";
import { CrossProbe, CrossProbeIndex } from "../cross-probe";
import { PartInfo } from "../part-info";
import { Project } from "../project";
import type { KCPartInfoElement } from "./common/part-info";
import "./common/part-info";
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
    #index?: CrossProbeIndex;
    #workspace_listeners: { dispose(): void }[] = [];
    /** Where the user last pressed the pointer, relative to <main> */
    #last_pointer = { x: 0, y: 0 };

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

        later(async () => {
            if (this.src) {
                const vfs = new FetchFileSystem([this.src]);
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
    }

    override render() {
        this.#part_info =
            html`<kc-part-info></kc-part-info>` as KCPartInfoElement;

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
                </main>
            </kc-ui-app>
        `;
    }
}

function first_board(project: Project): KicadPCB | undefined {
    for (const board of project.boards()) {
        return board;
    }
    return undefined;
}

window.customElements.define("kc-kicanvas-shell", KiCanvasShellElement);
