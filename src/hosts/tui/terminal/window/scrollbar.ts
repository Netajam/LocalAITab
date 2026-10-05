import { dim, bold, cyan, magenta } from '../../render';

/**
 * The bar down the right edge of the conversation: a thumb for what is in
 * view, and a mark for each point at its place in the whole conversation,
 * `◆` for a message sent and `•` for a reply begun, so the two tell apart
 * without colour. Pure, so where things land can be tested.
 */

/** A point's mark on the bar, and what the rule above the prompt calls it. */
export const POINT_GLYPH = { user: '◆', agent: '•' } as const;
const POINT_NAME = { user: 'your message', agent: 'reply' } as const;

export type Mark = 'user' | 'agent';

/** A point in the conversation: the row it starts on, counted from the first. */
export interface Point { row: number; kind: Mark }

/** Which bar row stands for conversation row `row`, of `total`, on a bar `height` rows tall. */
export function barRow(row: number, total: number, height: number): number {
  return Math.min(height - 1, Math.floor((row / Math.max(1, total)) * height));
}

/**
 * The bar, one character per conversation row on screen, or none when the
 * whole conversation fits. `top` is the first conversation row in view.
 */
export function scrollbar(height: number, total: number, top: number, points: Point[]): string[] {
  if (total <= height) { return []; }
  const from = barRow(top, total, height);
  const size = Math.max(1, Math.round((height * height) / total));
  const thumb = (r: number) => r >= from && r < Math.min(height, from + size);
  const dots = new Map<number, Mark>();
  // A user message wins a shared row: it is what people navigate by.
  for (const p of points) { const r = barRow(p.row, total, height); if (dots.get(r) !== 'user') { dots.set(r, p.kind); } }
  return Array.from({ length: height }, (_, r) => {
    const dot = dots.get(r);
    if (dot) { return dot === 'user' ? cyan(POINT_GLYPH.user) : magenta(POINT_GLYPH.agent); }
    return thumb(r) ? bold('┃') : dim('│');
  });
}

/**
 * Where a click on bar row `row` should take the view: to the point drawn
 * there when there is one, else to the same share of the conversation.
 * Returns the conversation row to bring to the top.
 */
export function clickTarget(row: number, height: number, total: number, points: Point[]): number {
  const hit = points.find((p) => barRow(p.row, total, height) === row);
  return hit ? hit.row : Math.floor((row / height) * total);
}

/**
 * Which point the view is at, for the rule above the prompt: the last one at
 * or above `top`, counted among its own kind ("your message 2 of 4").
 */
export function pointLabel(points: Point[], top: number): string | undefined {
  const at = [...points].reverse().find((p) => p.row <= top) ?? points[0];
  if (!at) { return undefined; }
  const same = points.filter((p) => p.kind === at.kind);
  return `${POINT_GLYPH[at.kind]} ${POINT_NAME[at.kind]} ${same.indexOf(at) + 1} of ${same.length}`;
}

/** The point before `top` (strictly), or after it, or undefined when there is none that way. */
export function neighbour(points: Point[], top: number, direction: 1 | -1): Point | undefined {
  return direction < 0
    ? [...points].reverse().find((p) => p.row < top)
    : points.find((p) => p.row > top);
}
