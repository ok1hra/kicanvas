/*
    Copyright (c) 2026 KiCanvas contributors.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Vec2 } from "./vec2";

/**
 * Points along a cubic Bezier curve, for drawing it as a polyline.
 *
 * @param segments - number of line segments; by default about one per
 *     0.1mm of the control polygon's length, between 8 and 64.
 */
export function cubic_bezier_points(
    p0: Vec2,
    p1: Vec2,
    p2: Vec2,
    p3: Vec2,
    segments?: number,
): Vec2[] {
    const length =
        p1.sub(p0).magnitude + p2.sub(p1).magnitude + p3.sub(p2).magnitude;
    const n = segments ?? Math.max(8, Math.min(64, Math.ceil(length / 0.1)));
    const points: Vec2[] = [];

    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const c = 3 * mt * t * t;
        const d = t * t * t;
        points.push(
            new Vec2(
                a * p0.x + b * p1.x + c * p2.x + d * p3.x,
                a * p0.y + b * p1.y + c * p2.y + d * p3.y,
            ),
        );
    }

    return points;
}
