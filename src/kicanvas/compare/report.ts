/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { Category, Comparison } from "./diff";

/** A compared revision, as shown in reports. */
export type RevisionLabel = { id: string; label: string };

export const category_names: Record<Category, string> = {
    components: "Components & BOM",
    nets: "Nets",
    layout: "Layout",
};

const categories: Category[] = ["components", "nets", "layout"];

export function markdown_report(
    project: string,
    a: RevisionLabel,
    b: RevisionLabel,
    result: Comparison,
    shown: Set<Category>,
): string {
    const lines = [`# Changes in ${project}: ${a.label} → ${b.label}`, ""];
    for (const category of categories) {
        if (!shown.has(category)) {
            continue;
        }
        const changes = result.changes.filter((c) => c.category == category);
        lines.push(`## ${category_names[category]} (${changes.length})`, "");
        if (!changes.length) {
            lines.push("No changes.", "");
            continue;
        }
        for (const c of changes) {
            lines.push(`- **${c.title}**`);
            for (const d of c.details) {
                lines.push(`  - ${d}`);
            }
        }
        lines.push("");
    }
    if (shown.has("components") && result.bom.length) {
        lines.push(
            `## BOM (${result.bom.length} rows changed)`,
            "",
            "| Status | Qty A → B | Value | Footprint | MPN | ID | References |",
            "|---|---|---|---|---|---|---|",
        );
        for (const r of result.bom) {
            lines.push(
                `| ${r.status} | ${r.refs_a.length} → ${r.refs_b.length} | ${r.value} | ${r.footprint} | ${r.mpn} | ${r.id} | ${(r.refs_b.length ? r.refs_b : r.refs_a).join(", ")} |`,
            );
        }
        lines.push("");
    }
    return lines.join("\n");
}

/** CSV with ";" separators, which Excel uses in most European locales. */
function csv(rows: (string | number)[][]) {
    const cell = (v: string | number) => {
        const s = String(v);
        return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // The byte order mark tells Excel the file is UTF-8.
    return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
}

export function changes_csv(result: Comparison, shown: Set<Category>) {
    return csv([
        ["Category", "Kind", "Change", "References", "Details"],
        ...result.changes
            .filter((c) => shown.has(c.category))
            .map((c) => [
                category_names[c.category],
                c.kind,
                c.title,
                c.refs.join(" "),
                c.details.join(" | "),
            ]),
    ]);
}

export function bom_csv(result: Comparison) {
    return csv([
        [
            "Status",
            "Qty A",
            "Qty B",
            "Value",
            "Footprint",
            "MPN",
            "ID",
            "References A",
            "References B",
        ],
        ...result.bom.map((r) => [
            r.status,
            r.refs_a.length,
            r.refs_b.length,
            r.value,
            r.footprint,
            r.mpn,
            r.id,
            r.refs_a.join(" "),
            r.refs_b.join(" "),
        ]),
    ]);
}

export function json_report(
    project: string,
    a: RevisionLabel,
    b: RevisionLabel,
    result: Comparison,
) {
    return JSON.stringify(
        {
            format: "kicanvas-compare/v1",
            project,
            a,
            b,
            changes: result.changes.map((c) => ({
                category: c.category,
                kind: c.kind,
                title: c.title,
                details: c.details,
                refs: c.refs,
                nets_a: c.nets_a,
                nets_b: c.nets_b,
                sheets: c.sheets,
            })),
            bom: result.bom,
        },
        null,
        2,
    );
}

/** Lets the user save some text as a file. */
export function download_text(name: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
