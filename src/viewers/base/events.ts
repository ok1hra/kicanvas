/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

class KiCanvasEvent<T> extends CustomEvent<T> {
    constructor(name: string, detail: T, bubbles = false) {
        super(name, { detail: detail, composed: true, bubbles: bubbles });
    }
}

export class KiCanvasLoadEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:load";

    constructor() {
        super(KiCanvasLoadEvent.type, null);
    }
}

interface SelectDetails {
    item: unknown;
    previous: unknown;
}

export class KiCanvasSelectEvent extends KiCanvasEvent<SelectDetails> {
    static readonly type = "kicanvas:select";

    constructor(detail: SelectDetails) {
        super(KiCanvasSelectEvent.type, detail, true);
    }
}

interface MouseMoveDetails {
    x: number;
    y: number;
}

export class KiCanvasMouseMoveEvent extends KiCanvasEvent<MouseMoveDetails> {
    static readonly type = "kicanvas:mousemove";

    constructor(detail: MouseMoveDetails) {
        super(KiCanvasMouseMoveEvent.type, detail, true);
    }
}

export type NetSelectDetails = {
    /**
     * The selected net, or null when the selection was cleared. The
     * schematic viewer uses SheetNet objects, the board viewer net names.
     */
    net: unknown;
    /** Schematic: all selected nets on the sheet, e.g. of a bus. */
    nets?: unknown[];
    /**
     * Schematic: names of the bus members that were selected, which can
     * include nets that aren't on the sheet.
     */
    members?: string[];
};

/** The user selected a net, e.g. by clicking a wire or a track. */
export class KiCanvasNetSelectEvent extends KiCanvasEvent<NetSelectDetails> {
    static readonly type = "kicanvas:net-select";

    constructor(detail: NetSelectDetails) {
        super(KiCanvasNetSelectEvent.type, detail);
    }
}

/** An item was double clicked, e.g. a sheet to open it. */
export class KiCanvasActivateEvent extends KiCanvasEvent<{ item: unknown }> {
    static readonly type = "kicanvas:activate";

    constructor(detail: { item: unknown }) {
        super(KiCanvasActivateEvent.type, detail);
    }
}

/** The user panned or zoomed, or the viewer was resized. */
export class KiCanvasViewportEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:viewport";

    constructor() {
        super(KiCanvasViewportEvent.type, null);
    }
}

/**
 * What's selected or highlighted changed, also when that wasn't done by the
 * user (e.g. by cross-probing). See Viewer.selection_bbox().
 */
export class KiCanvasSelectionEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:selection";

    constructor() {
        super(KiCanvasSelectionEvent.type, null);
    }
}

/** Layer visibility, highlighting or zone fill display changed. */
export class KiCanvasLayersChangedEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:layers-changed";

    constructor() {
        super(KiCanvasLayersChangedEvent.type, null);
    }
}

// Event maps for type safe addEventListener.

export interface KiCanvasEventMap {
    [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
    [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
    [KiCanvasMouseMoveEvent.type]: KiCanvasMouseMoveEvent;
    [KiCanvasLayersChangedEvent.type]: KiCanvasLayersChangedEvent;
    [KiCanvasNetSelectEvent.type]: KiCanvasNetSelectEvent;
    [KiCanvasActivateEvent.type]: KiCanvasActivateEvent;
    [KiCanvasViewportEvent.type]: KiCanvasViewportEvent;
    [KiCanvasSelectionEvent.type]: KiCanvasSelectionEvent;
}

declare global {
    interface WindowEventMap {
        [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
        [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
    }

    interface HTMLElementEventMap {
        [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
        [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
    }
}
