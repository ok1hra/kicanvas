/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/**
 * A minimal ZIP writer: files are deflated with the browser's
 * CompressionStream where that's available (and worth it), else stored.
 */

export type ZipEntry = { name: string; data: Uint8Array | string | Blob };

let crc_table: Uint32Array | undefined;

export function crc32(data: Uint8Array): number {
    if (!crc_table) {
        crc_table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
            crc_table[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = crc_table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function bytes(data: ZipEntry["data"]): Promise<Uint8Array> {
    if (typeof data == "string") {
        return new TextEncoder().encode(data);
    }
    if (data instanceof Blob) {
        return new Uint8Array(await data.arrayBuffer());
    }
    return data;
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
    if (typeof CompressionStream == "undefined") {
        return null;
    }
    try {
        const stream = new Blob([data as BlobPart])
            .stream()
            .pipeThrough(new CompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
        return null;
    }
}

function dos_time(date: Date) {
    const time =
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2);
    const day =
        ((date.getFullYear() - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();
    return { time, day };
}

/** Packs files into a ZIP archive. */
export async function zip(entries: ZipEntry[], date = new Date()) {
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    const { time, day } = dos_time(date);
    let offset = 0;

    for (const entry of entries) {
        const name = new TextEncoder().encode(entry.name);
        const raw = await bytes(entry.data);
        const crc = crc32(raw);
        // PNGs are compressed already.
        const deflated = /\.png$/i.test(entry.name) ? null : await deflate(raw);
        const stored = !deflated || deflated.length >= raw.length;
        const body = stored ? raw : deflated!;
        const method = stored ? 0 : 8;

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true); // version needed
        local.setUint16(6, 0x0800, true); // UTF-8 names
        local.setUint16(8, method, true);
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, body.length, true);
        local.setUint32(22, raw.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        parts.push(new Uint8Array(local.buffer), name, body);

        const dir = new DataView(new ArrayBuffer(46));
        dir.setUint32(0, 0x02014b50, true);
        dir.setUint16(4, 20, true); // version made by
        dir.setUint16(6, 20, true); // version needed
        dir.setUint16(8, 0x0800, true);
        dir.setUint16(10, method, true);
        dir.setUint16(12, time, true);
        dir.setUint16(14, day, true);
        dir.setUint32(16, crc, true);
        dir.setUint32(20, body.length, true);
        dir.setUint32(24, raw.length, true);
        dir.setUint16(28, name.length, true);
        dir.setUint32(42, offset, true);
        central.push(new Uint8Array(dir.buffer), name);

        offset += 30 + name.length + body.length;
    }

    const central_size = central.reduce((n, b) => n + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, central_size, true);
    end.setUint32(16, offset, true);

    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    return new Blob(all as BlobPart[], {
        type: "application/zip",
    });
}
