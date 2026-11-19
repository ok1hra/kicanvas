/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { SchematicViewer } from "../../../viewers/schematic/viewer";
import type { ProjectPage } from "../../project";
import { KCViewerElement } from "../common/viewer";

export class KCSchematicViewerElement extends KCViewerElement<SchematicViewer> {
    override async load(src: ProjectPage) {
        this.loaded = false;
        // Pass the page rather than just its document: a schematic file can
        // be used by several sheets, and the viewer needs the page's sheet
        // path to show that instance's references, sheet name, page number,
        // etc.
        await this.viewer.load(src);
    }

    protected override update_theme(): void {
        this.viewer.theme = this.themeObject.schematic;
    }

    protected override make_viewer(): SchematicViewer {
        return new SchematicViewer(
            this.canvas,
            !this.disableinteraction,
            this.themeObject.schematic,
        );
    }
}

window.customElements.define("kc-schematic-viewer", KCSchematicViewerElement);
