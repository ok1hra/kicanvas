/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox } from "../base/math";

/**
 * What a shared link shows: the schematic sheet, the visible area of both
 * views and what's selected or highlighted.
 */
export type ViewState = {
    /** The schematic page, by ProjectPage.project_path */
    sheet?: string;
    /** Visible area of the schematic, in mm */
    sch?: BBox;
    /** Visible area of the board, in mm */
    board?: BBox;
    /** Board viewed from the back */
    flip?: boolean;
    /** Selected part, by reference */
    part?: string;
    /** Highlighted nets, by name (see CrossProbeIndex.net_key) */
    nets?: string[];
};

function encode_bbox(bb: BBox) {
    return [bb.x, bb.y, bb.w, bb.h].map((v) => +v.toFixed(3)).join(",");
}

function decode_bbox(text: string | null): BBox | undefined {
    if (!text) {
        return undefined;
    }
    const v = text.split(",").map(Number);
    if (v.length != 4 || v.some((n) => !Number.isFinite(n)) || v[2]! <= 0) {
        return undefined;
    }
    return new BBox(v[0]!, v[1]!, v[2]!, v[3]!);
}

/** The state as the hash part of a URL (without "#"). */
export function encode_view(state: ViewState): string {
    const params = new URLSearchParams();
    if (state.sheet) {
        params.set("sheet", state.sheet);
    }
    if (state.sch) {
        params.set("s", encode_bbox(state.sch));
    }
    if (state.board) {
        params.set("b", encode_bbox(state.board));
    }
    if (state.flip) {
        params.set("flip", "1");
    }
    if (state.part) {
        params.set("part", state.part);
    }
    // Net names can contain commas, so each gets its own parameter.
    for (const net of state.nets ?? []) {
        params.append("net", net);
    }
    return params.toString();
}

/** Reads a state from a URL's hash; null if it has none. */
export function decode_view(hash: string): ViewState | null {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const state: ViewState = {
        sheet: params.get("sheet") ?? undefined,
        sch: decode_bbox(params.get("s")),
        board: decode_bbox(params.get("b")),
        flip: params.get("flip") == "1",
        part: params.get("part") ?? undefined,
        nets: params.getAll("net"),
    };
    const empty =
        !state.sheet &&
        !state.sch &&
        !state.board &&
        !state.flip &&
        !state.part &&
        !state.nets!.length;
    return empty ? null : state;
}
