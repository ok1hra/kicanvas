/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Project } from "../project";
import { FileSystemBase, type FileEntry } from "../services/vfs";

/**
 * Access to the git history of the project, served by the local server
 * (`npm run open`, see scripts/open.js).
 */

/** The working copy, including changes that aren't committed. */
export const WORKTREE = "WORKTREE";

export type GitInfo = {
    available: boolean;
    repository?: string;
    /** The project's directory in the repository */
    subdir?: string;
    branch?: string;
    /** The working copy has uncommitted changes in the project */
    dirty?: boolean;
};

export type Commit = {
    sha: string;
    short: string;
    author: string;
    /** ISO 8601 */
    date: string;
    subject: string;
};

async function get_json<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
}

let info_promise: Promise<GitInfo> | undefined;
let commits_promise: Promise<Commit[]> | undefined;

/**
 * Whether git history is available, and about the repository.
 *
 * @param refresh - ask again, e.g. whether the working copy has changes
 */
export function git_info(refresh = false): Promise<GitInfo> {
    if (!info_promise || refresh) {
        info_promise = get_json<GitInfo>("git/api/info").catch(() => ({
            available: false,
        }));
    }
    return info_promise;
}

/** Commits that change the project, newest first. */
export function git_commits(refresh = false): Promise<Commit[]> {
    if (!commits_promise || refresh) {
        commits_promise = get_json<Commit[]>("git/api/commits");
        commits_promise.catch(() => (commits_promise = undefined));
    }
    return commits_promise;
}

/** The project's KiCad files at a revision. */
class RevisionFileSystem extends FileSystemBase {
    constructor(
        private rev: string,
        private names: string[],
    ) {
        super();
    }

    protected async load_file(name: string): Promise<File> {
        const response = await fetch(
            `git/rev/${encodeURIComponent(this.rev)}/${encodeURIComponent(name)}`,
        );
        if (!response.ok) {
            throw new Error(`Unable to load ${name} at ${this.rev}`);
        }
        return new File([await response.blob()], name);
    }

    protected async enumerate(): Promise<FileEntry[]> {
        return this.names.map((path) => ({ path, type: "file" }));
    }
}

/** The project's files at a revision (a commit's SHA, or WORKTREE). */
export async function revision_fs(rev: string) {
    const names = await get_json<string[]>(
        `git/api/files?rev=${encodeURIComponent(rev)}`,
    );
    // The project file first, so the project's settings are known.
    names.sort(
        (a, b) =>
            Number(b.endsWith(".kicad_pro")) - Number(a.endsWith(".kicad_pro")),
    );
    const fs = new RevisionFileSystem(rev, names);
    await fs.setup();
    return fs;
}

const projects = new Map<string, Promise<Project>>();

/** The project as it is at a revision (a commit's SHA, or WORKTREE). */
export function load_revision(rev: string): Promise<Project> {
    let project = projects.get(rev);
    if (!project) {
        project = (async () => {
            const p = new Project();
            await p.load(await revision_fs(rev));
            return p;
        })();
        // Don't keep failures (or the working copy, which can change).
        project.catch(() => projects.delete(rev));
        if (rev != WORKTREE) {
            projects.set(rev, project);
        }
    }
    return project;
}
