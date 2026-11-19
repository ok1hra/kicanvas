# Development

This page provides some technical background for those wishing to dig into KiCanvas's source code.

## Contributing

Contributions are welcome! However, since KiCanvas is in a super early stage please file an issue before you start working on something so we can coordinate. Also, please read our [Code of Conduct].

## Workflow

- Make each change on its own branch off `main`.
- Run `npm run serve` and open http://localhost:8001 to try changes; it rebuilds automatically.
- Before committing, run `npm run lint && npm test` (the same checks CI runs).
- When fixing or extending a parser, add a small file under `test/kicad/files/` that exercises it.
- Check rendering against a real project with `npm run render-check` (below).

### Checking rendering against a real project

`npm run render-check` loads KiCad files into the standalone viewer in headless Chrome, takes a screenshot of every page, and reports browser errors and the file tokens the parser skipped:

```sh
npm run render-check -- path/to/project/
npm run render-check -- path/to/project/ --pages "Board,Power,mcu.kicad_sch"
```

Screenshots go to `debug/render-check/` by default (ignored by git, and not under `build/`, which is published with the docs). A directory argument loads the `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` files directly inside it. The script exits with status 1 when loading fails or the browser reports an error, so it can also be used as a smoke test. It needs Chrome or Chromium; set `CHROME_PATH` or pass `--chrome` if it isn't found automatically. Run it with `--help` for all options.

### Comparing with KiCad

`npm run kicad-compare` renders a project's schematic sheets and board copper layers with KiCad's `kicad-cli` and with KiCanvas, and measures how well they match:

```sh
npm run kicad-compare -- path/to/project/
npm run kicad-compare -- path/to/project/ --sheets "Power,MCU" --layers F.Cu,B.Cu
```

For each sheet and layer it reports recall (how much of KiCad's drawing KiCanvas also draws) and precision (how much of KiCanvas' drawing KiCad also draws), and writes the images, a diff (red: only KiCad, blue: only KiCanvas) and an `index.html` report to `debug/kicad-compare/<project>/`. It uses the official KiCad flatpak (`org.kicad.KiCad`) if it's installed; set `KICAD_CLI` or pass `--kicad-cli` to use another `kicad-cli`. Use a KiCad version that can read the project's files.

## Technical overview

KiCanvas is written in modern vanilla [TypeScript] and uses the [Canvas] element and [WebGL] for rendering. KiCanvas's user interface is built using [Web Components].

KiCanvas notably does not have any runtime dependencies. Everything it needs to work is bundled together and nothing pollutes the global namespace. This is critical to KiCanvas's goal of being easy to embed.

## Source code organization

KiCanvas's source code under `./src` is organized into the following:

- `base` contains generic, widely applicable utilities for working with JavaScript, TypeScript, the DOM, and math. These are the sort of things you'd use across multiple, unrelated projects.
- `kicad` contains the KiCad data layer and text layout implementation. This is where parsers for KiCad files and associated models live.
- `graphics` contains the rendering engine. It is somewhat generic- it handles rendering primitives such as lines, circles, and polygons, but is also tailored to KiCanvas's needs in specific ways.
- `viewers` contains classes that implement viewers for different KiCad documents. Viewers handle creating geometry using "Painters" and managing "Layers" for the renderer to draw. Viewers do not provide a user interface on their own, they're designed with high-level APIs that let various user interface elements control the viewer.
- `kc-ui` contains generic, low-level web components used to build KiCanvas's user interface. Elements in here are generic enough to be re-used in other projects, but may be slightly tailored to KiCanvas's needs. For example, `<kc-ui-button>` and `<kc-ui-icon>`.
- `kicanvas` contains the KiCanvas application and its elements. Elements here implement KiCanvas functionality, such as `<kc-project-panel>` and `<kc-symbols-panel>`.

[KiCanvas]: https://kicanvas.org
[TypeScript]: https://typescript.dev
[Canvas]: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API
[WebGL]: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API
[Web Components]: https://developer.mozilla.org/en-US/docs/Web/API/Web_components
[Code of Conduct]: https://github.com/theacodes/kicanvas/blob/main/CODE_OF_CONDUCT.md
