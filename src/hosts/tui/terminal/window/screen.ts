import { hardWrap, visibleWidth, cyan } from '../../render';
import { Input, Mouse, startInput } from './input';
import { Mark, Point, scrollbar, clickTarget, neighbour, pointLabel } from './scrollbar';

/**
 * The whole window, owned: the conversation fills the top and scrolls on its
 * own, whatever `draw` is given stays pinned to the bottom rows, and the keys
 * and wheel turns typed into it come back out.
 *
 * It runs on the terminal's alternate screen, the way full-screen tools do,
 * because in the normal screen the terminal scrolls its own scrollback and
 * takes the prompt with it. So the conversation keeps its own scrollback here,
 * moved by the wheel or PgUp/PgDn, and is printed to the normal screen when
 * the program leaves, so it is still there afterwards. Lines can be marked as
 * the start of a message or a reply: those are the points ⌥↑/⌥↓ jump between
 * and the dots on the scroll bar down the right edge.
 */

/** Lines kept for scrolling back; the oldest go first past this. */
const KEEP = 20000;
const WHEEL_ROWS = 3;

interface Line { text: string; mark?: Mark; width?: number; rows?: string[] }

/** Columns kept clear on the right for the scroll bar: a gap and the bar. */
const BAR_COLUMNS = 2;

export class Screen {
  private readonly lines: Line[] = [];
  /** How many rows above the newest the view ends; 0 follows the conversation. */
  private back = 0;
  /** Rows printed while scrolled back, not yet seen. */
  private unseen = 0;
  private active = false;
  private input?: Input;

  get rows(): number { return process.stdout.rows || 24; }
  get columns(): number { return process.stdout.columns || 100; }

  /** Takes over the window, the alternate screen with mouse reports in SGR form, and starts reading keys. */
  enter(onKey: Parameters<typeof startInput>[0], onMouse: (event: Mouse) => void): void {
    process.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J');
    this.active = true;
    this.input = startInput(onKey, onMouse);
  }

  /** Gives the window back and prints the conversation into it, so it stays in the scrollback. */
  leave(): void {
    if (!this.active) { return; }
    this.active = false;
    this.input?.stop();
    process.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
    if (this.lines.length) { process.stdout.write(this.lines.map((l) => l.text).join('\n') + '\n'); }
  }

  /**
   * Adds to the conversation, its first line marked as a point when `mark`
   * is given. Scrolled back, the view stays put and counts what arrived below.
   */
  append(text: string, mark?: Mark): void {
    const added: Line[] = text.split('\n').map((t, i) => ({ text: t, mark: i === 0 ? mark : undefined }));
    this.lines.push(...added);
    if (this.lines.length > KEEP) { this.lines.splice(0, this.lines.length - KEEP); }
    if (this.back > 0) {
      const rows = added.reduce((n, l) => n + this.rowsOf(l).length, 0);
      this.back += rows;
      this.unseen += rows;
    }
  }

  /** Positive scrolls back towards older lines. `page` moves by the conversation's height. */
  scroll(by: number, conversationRows: number, page = false): void {
    const step = page ? Math.max(1, conversationRows - 2) * Math.sign(by) : by * WHEEL_ROWS;
    const most = Math.max(0, this.totalRows() - conversationRows);
    this.back = Math.max(0, Math.min(most, this.back + step));
    if (this.back === 0) { this.unseen = 0; }
  }

  /** To the previous point (-1) or the next (+1), at the top of the view; past the last, to the newest line. */
  jump(direction: 1 | -1, conversationRows: number): void {
    const target = neighbour(this.points(), this.top(conversationRows), direction);
    if (target) { this.showFrom(target.row, conversationRows); } else if (direction > 0) { this.follow(); }
  }

  /** A click on the scroll bar: to the point drawn there, or that share of the conversation. False elsewhere. */
  click(col: number, row: number, conversationRows: number): boolean {
    if (col !== this.columns || row > conversationRows || this.totalRows() <= conversationRows) { return false; }
    this.showFrom(clickTarget(row - 1, conversationRows, this.totalRows(), this.points()), conversationRows);
    return true;
  }

  /** Back to the newest line. */
  follow(): void {
    this.back = 0;
    this.unseen = 0;
  }

  get scrolled(): boolean { return this.back > 0; }

  /** For the rule above the pinned rows while scrolled back: which point, what is below, how to get back. */
  note(conversationRows: number): string | undefined {
    if (!this.back) { return undefined; }
    const below = this.unseen ? `${this.unseen} new line${this.unseen === 1 ? '' : 's'} below` : `${this.back} line${this.back === 1 ? '' : 's'} below`;
    const label = pointLabel(this.points(), this.top(conversationRows));
    return cyan(`↑ ${label ? `${label} · ` : ''}${below} · ⌥↑⌥↓ points · PgDn or wheel to return`);
  }

  /**
   * Draws the frame in one write: the conversation rows that fit above
   * `pinned`, then `pinned`, then the cursor at `cursor` within `pinned`, or
   * hidden when there is none.
   */
  draw(pinned: string[], cursor?: { row: number; col: number }): void {
    const height = this.rows;
    const bottom = pinned.slice(-height);
    const viewRows = height - bottom.length;
    const top = this.view(viewRows);
    const bar = scrollbar(viewRows, this.totalRows(), this.top(viewRows), this.points());
    let out = '\x1b[?2026h\x1b[H';
    [...top, ...bottom].forEach((row, i) => {
      out += `\x1b[${i + 1};1H\x1b[2K${row}`;
      if (bar[i]) { out += `\x1b[${i + 1};${this.columns}H${bar[i]}`; }
    });
    out += cursor
      ? `\x1b[${height - bottom.length + cursor.row + 1};${cursor.col + 1}H\x1b[?25h`
      : '\x1b[?25l';
    process.stdout.write(out + '\x1b[?2026l');
  }

  /** The `height` rows the view shows, bottom-aligned to the pinned area like a chat. */
  private view(height: number): string[] {
    const out: string[] = [];
    let skip = this.back;
    for (let i = this.lines.length - 1; i >= 0 && out.length < height; i--) {
      const rows = this.rowsOf(this.lines[i]);
      for (let j = rows.length - 1; j >= 0 && out.length < height; j--) {
        if (skip > 0) { skip--; continue; }
        out.unshift(rows[j]);
      }
    }
    while (out.length < height) { out.unshift(''); }
    return out;
  }

  /** The first conversation row in view. */
  private top(conversationRows: number): number {
    return Math.max(0, this.totalRows() - this.back - conversationRows);
  }

  /** Scrolls so that conversation row `row` is at the top of the view, as far as the conversation allows. */
  private showFrom(row: number, conversationRows: number): void {
    const most = Math.max(0, this.totalRows() - conversationRows);
    this.back = Math.max(0, Math.min(most, this.totalRows() - conversationRows - row));
    if (this.back === 0) { this.unseen = 0; }
  }

  /** Every marked line, by the conversation row it starts on. */
  private points(): Point[] {
    const out: Point[] = [];
    let row = 0;
    for (const line of this.lines) {
      if (line.mark) { out.push({ row, kind: line.mark }); }
      row += this.rowsOf(line).length;
    }
    return out;
  }

  /** A line cut to the width left of the scroll bar, kept until the width changes. */
  private rowsOf(line: Line): string[] {
    const width = Math.max(10, this.columns - 1 - BAR_COLUMNS);
    if (line.width !== width) {
      line.rows = visibleWidth(line.text) <= width ? [line.text] : hardWrap(line.text, width);
      line.width = width;
    }
    return line.rows!;
  }

  private totalRows(): number {
    return this.lines.reduce((n, l) => n + this.rowsOf(l).length, 0);
  }
}
