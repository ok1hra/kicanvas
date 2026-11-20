/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { sorted_by_numeric_strings } from "../base/array";
import { Barrier } from "../base/async";
import { type IDisposable } from "../base/disposable";
import { filter, first, length, map } from "../base/iterator";
import { Logger } from "../base/log";
import { basename, dirname, normalize_join } from "../base/paths";
import { is_string, type Constructor } from "../base/types";
import { KicadPCB, KicadSch, ProjectSettings } from "../kicad";
import { instance_for } from "../kicad/schematic";
import type { SchematicSheet } from "../kicad/schematic";
import type { IFileSystem } from "./services/vfs";

const log = new Logger("kicanvas:project");

export class Project extends EventTarget implements IDisposable {
    #fs: IFileSystem;
    #files_by_name: Map<string, KicadPCB | KicadSch | null> = new Map();
    #pages_by_path: Map<string, ProjectPage> = new Map();
    #root_schematic_page?: ProjectPage;
    #project_filename?: string;

    public loaded: Barrier = new Barrier();
    public settings: ProjectSettings = new ProjectSettings();

    public dispose() {
        this.#files_by_name.clear();
        this.#pages_by_path.clear();
    }

    public async load(fs: IFileSystem) {
        log.info(`Loading project from ${fs.constructor.name}`);

        this.settings = new ProjectSettings();
        this.#files_by_name.clear();
        this.#pages_by_path.clear();
        this.#root_schematic_page = undefined;
        this.#project_filename = undefined;

        this.#fs = fs;

        const proj_promises = [];

        // load project file
        for (const filename of this.#fs.list()) {
            proj_promises.push(this.#load_file(filename));
        }

        await Promise.all(proj_promises);

        // 'Recursively' resolve all schematics until none remain
        let load_new = true;
        const loaded_files: string[] = [];
        while (load_new) {
            load_new = false;

            const pending = [];
            for (const sch of this.schematics()) {
                const base_dir = dirname(sch.filename);
                for (const subsch of sch.sheets) {
                    if (!subsch.sheetfile) {
                        continue;
                    }

                    const new_file = normalize_join(base_dir, subsch.sheetfile);
                    if (loaded_files.includes(new_file)) {
                        // file loaded or skipped
                        continue;
                    }

                    load_new = true;
                    loaded_files.push(new_file);

                    if (await this.#fs.has(new_file)) {
                        // load file, it changes this.#files_by_name and causes calling
                        // this.schematics() will return a new result.
                        pending.push(this.#load_file(new_file));
                    } else {
                        // skip non-existent files to allow loading an incomplete schematics
                        log.warn(`file "${new_file}" is not existed, skip it.`);
                    }
                }
            }

            await Promise.all(pending);
        }

        this.#determine_schematic_hierarchy();

        this.loaded.open();

        this.dispatchEvent(
            new CustomEvent("load", {
                detail: this,
            }),
        );
    }

    async #load_file(filename: string) {
        log.info(`Loading file ${filename}`);

        if (filename.endsWith(".kicad_sch")) {
            return await this.#load_doc(KicadSch, filename);
        }
        if (filename.endsWith(".kicad_pcb")) {
            return await this.#load_doc(KicadPCB, filename);
        }
        if (filename.endsWith(".kicad_pro")) {
            return this.#load_meta(filename);
        }

        log.warn(`Couldn't load ${filename}: unknown file type`);
    }

    async #load_doc(
        document_class: Constructor<KicadPCB | KicadSch>,
        filename: string,
    ) {
        if (this.#files_by_name.has(filename)) {
            return this.#files_by_name.get(filename);
        }

        const text = await this.#get_file_text(filename);
        const doc = new document_class(filename, text);
        doc.project = this;

        this.#files_by_name.set(filename, doc);

        if (doc instanceof KicadPCB) {
            // Add PCBs to the list of pages. Schematics will
            // get added during #determine_schematic_hierarchy.
            const page = new ProjectPage(
                this,
                "pcb",
                doc.filename,
                "",
                "Board",
                "",
            );
            this.#pages_by_path.set(page.project_path, page);
        }

        return doc;
    }

    async #load_meta(filename: string) {
        const text = await this.#get_file_text(filename);
        const data = JSON.parse(text);
        this.settings = ProjectSettings.load(data);
        this.#project_filename = filename;
    }

    async #get_file_text(filename: string) {
        return await (await this.#fs.get(filename)).text();
    }

    #determine_schematic_hierarchy() {
        log.info("Determining schematic hierarchy");

        const root = this.#find_root_schematic();
        let pages: ProjectPage[] = [];

        if (root) {
            this.#root_schematic_page = new ProjectPage(
                this,
                "schematic",
                root.filename,
                `/${root.uuid}`,
                "Root",
                "1",
            );
            pages.push(this.#root_schematic_page);

            // Walk the hierarchy from the root, like KiCad does. Schematic
            // files that aren't reached are listed separately below.
            const walk = (schematic: KicadSch, path: string, depth: number) => {
                if (depth > 32) {
                    log.warn(`Sheet hierarchy too deep at ${path}`);
                    return;
                }
                for (const sheet of schematic.sheets) {
                    if (!sheet.sheetfile) {
                        continue;
                    }
                    const filename = normalize_join(
                        dirname(schematic.filename),
                        sheet.sheetfile,
                    );
                    const child = this.#files_by_name.get(filename);
                    if (!(child instanceof KicadSch)) {
                        continue;
                    }

                    const sheet_path = `${path}/${sheet.uuid}`;
                    const instance =
                        instance_for(sheet.instances, path) ??
                        // KiCad 6 stored sheet instances in the root
                        // schematic, without the root's UUID.
                        root.sheet_instances?.get(
                            sheet_path.slice(root.uuid.length + 1),
                        );

                    pages.push(
                        new ProjectPage(
                            this,
                            "schematic",
                            child.filename,
                            sheet_path,
                            sheet.sheetname ?? sheet.sheetfile,
                            instance?.page ?? "",
                            sheet,
                        ),
                    );

                    walk(child, sheet_path, depth + 1);
                }
            };
            walk(root, `/${root.uuid}`, 0);
        }

        // Sort the pages we've collected so far and then insert them
        // into the pages map.
        pages = sorted_by_numeric_strings(pages, (p) => p.page!);

        for (const page of pages) {
            this.#pages_by_path.set(page.project_path, page);
        }

        // Add any "orphan" sheets to the list of pages now that we've added all
        // the hierarchical ones.
        const seen_schematic_files = new Set(
            map(this.#pages_by_path.values(), (p) => p.filename),
        );

        for (const schematic of this.schematics()) {
            if (!seen_schematic_files.has(schematic.filename)) {
                const page = new ProjectPage(
                    this,
                    "schematic",
                    schematic.filename,
                    `/${schematic.uuid}`,
                    schematic.filename,
                );
                this.#pages_by_path.set(page.project_path, page);
            }
        }

        // Finally, if no root schematic was found, just use the first one we
        // saw. Note that boards are pages too, so they must be skipped.
        this.#root_schematic_page ??= first(
            filter(this.#pages_by_path.values(), (p) => p.type == "schematic"),
        );

        if (!this.#root_schematic_page && this.has_schematics) {
            log.error("No valid root schematic was found.");
        }
    }

    /**
     * The root schematic is the one named after the project file, as in
     * KiCad. Without a project file, it's the schematic that's the common
     * ancestor of the other schematics' sheet instances.
     */
    #find_root_schematic(): KicadSch | undefined {
        if (this.#project_filename) {
            const root = this.#files_by_name.get(
                this.#project_filename.replace(/\.kicad_pro$/, ".kicad_sch"),
            );
            if (root instanceof KicadSch) {
                return root;
            }
        }

        const paths_to_schematics = new Map<string, KicadSch>();
        const sheet_paths: string[] = [];

        for (const schematic of this.schematics()) {
            paths_to_schematics.set(`/${schematic.uuid}`, schematic);

            for (const sheet of schematic.sheets) {
                for (const instance of sheet.instances.values()) {
                    paths_to_schematics.set(instance.path, schematic);
                    sheet_paths.push(`${instance.path}/${sheet.uuid}`);
                }
            }
        }

        // Walk through the sheet paths from shortest to longest and find the
        // first one whose parent is a known schematic: that's the common
        // ancestor (root).
        sheet_paths.sort((a, b) => a.length - b.length);
        for (const path of sheet_paths) {
            const parent_path = path.split("/").slice(0, -1).join("/");
            const root = parent_path && paths_to_schematics.get(parent_path);
            if (root) {
                return root;
            }
        }

        // A project with a single schematic.
        const schematics = [...this.schematics()];
        return schematics.length == 1 ? schematics[0] : undefined;
    }

    public *files() {
        yield* this.#files_by_name.values();
    }

    public file_by_name(name: string) {
        return this.#files_by_name.get(name);
    }

    public *boards() {
        for (const value of this.#files_by_name.values()) {
            if (value instanceof KicadPCB) {
                yield value;
            }
        }
    }

    public get has_boards() {
        return length(this.boards()) > 0;
    }

    public *schematics() {
        for (const value of this.#files_by_name.values()) {
            if (value instanceof KicadSch) {
                yield value;
            }
        }
    }

    public get has_schematics() {
        return length(this.schematics()) > 0;
    }

    public *pages() {
        yield* this.#pages_by_path.values();
    }

    public get first_page() {
        return first(this.pages());
    }

    public get root_schematic_page() {
        return this.#root_schematic_page;
    }

    public page_by_path(project_path: string) {
        return this.#pages_by_path.get(project_path);
    }

    /** Find the schematic page for a hierarchical sheet path */
    public page_by_sheet_path(sheet_path: string) {
        for (const page of this.#pages_by_path.values()) {
            if (page.type == "schematic" && page.sheet_path == sheet_path) {
                return page;
            }
        }
        return undefined;
    }

    /**
     * The project's name, as used for ${PROJECTNAME}: the name of the
     * .kicad_pro file, or of the root schematic if there isn't one.
     */
    public get name(): string {
        const filename =
            this.#project_filename ??
            this.#root_schematic_page?.filename ??
            first(this.files())?.filename ??
            "";
        return basename(filename).replace(/\.kicad_(pro|sch|pcb)$/, "");
    }

    /**
     * Bus aliases, from the project file (KiCad 9 and later) and from
     * schematics (older versions).
     */
    public get bus_aliases(): Map<string, string[]> {
        const aliases = new Map<string, string[]>();
        for (const schematic of this.schematics()) {
            for (const alias of schematic.bus_aliases ?? []) {
                if (alias.name) {
                    aliases.set(alias.name, alias.members);
                }
            }
        }
        const from_settings = this.settings.schematic?.["bus_aliases"];
        if (from_settings && typeof from_settings == "object") {
            for (const [name, members] of Object.entries(from_settings)) {
                if (Array.isArray(members)) {
                    aliases.set(name, members.map(String));
                }
            }
        }
        return aliases;
    }

    /**
     * Number of sheets in the schematic hierarchy, as used for ${##}.
     */
    public get sheet_count(): number {
        return length(
            filter(
                this.#pages_by_path.values(),
                (p) => p.type == "schematic" && p.page !== undefined,
            ),
        );
    }

    /**
     * Human readable sheet path, like KiCad's SCH_SHEET_PATH::PathHumanReadable.
     *
     * For example, "/" for the root sheet and "/Power/Regulator/" for a sheet
     * named "Regulator" inside of a sheet named "Power".
     */
    public human_sheet_path(sheet_path: string): string {
        const parts = sheet_path.split("/").filter(Boolean);
        const names = [];

        // The first part is the root sheet, which isn't named in the path.
        for (let i = 2; i <= parts.length; i++) {
            const page = this.page_by_sheet_path(
                `/${parts.slice(0, i).join("/")}`,
            );
            names.push(page?.sheet?.sheetname ?? page?.name ?? parts[i - 1]);
        }

        return names.length ? `/${names.join("/")}/` : "/";
    }

    /**
     * Resolve project-level text variables, see PROJECT::TextVarResolver.
     */
    public resolve_text_var(name: string): string | undefined {
        switch (name) {
            case "PROJECTNAME":
                return this.name;
            case "CURRENT_DATE":
                return new Date().toISOString().slice(0, 10);
        }

        const vars = this.settings.text_variables ?? {};
        if (Object.hasOwn(vars, name)) {
            return vars[name];
        }

        return undefined;
    }

    public async download(name: string) {
        if (this.#pages_by_path.has(name)) {
            name = this.#pages_by_path.get(name)!.filename;
        }
        return await this.#fs.download(name);
    }

    #active_page: ProjectPage | null = null;

    public get active_page() {
        return this.#active_page;
    }

    public set_active_page(
        page_or_path: ProjectPage | string | null | undefined,
    ) {
        let page;

        if (is_string(page_or_path)) {
            page = this.page_by_path(page_or_path);
        } else {
            page = page_or_path;
        }

        if (!page) {
            page = this.first_page;
        }

        if (!page) {
            throw new Error(`Unable to find ${page_or_path}`);
        }

        this.#active_page = page;

        this.dispatchEvent(
            new CustomEvent("change", {
                detail: this,
            }),
        );
    }
}

export class ProjectPage {
    constructor(
        public project: Project,
        public type: "pcb" | "schematic",
        public filename: string,
        public sheet_path: string,
        public name?: string,
        public page?: string,
        /** The sheet symbol (in the parent schematic) for this page, if any */
        public sheet?: SchematicSheet,
    ) {}

    /**
     * A unique identifier for this page within the project,
     * made from the filename and sheet path.
     */
    get project_path() {
        if (this.sheet_path) {
            return `${this.filename}:${this.sheet_path}`;
        } else {
            return this.filename;
        }
    }

    get document() {
        return this.project.file_by_name(this.filename)!;
    }
}
