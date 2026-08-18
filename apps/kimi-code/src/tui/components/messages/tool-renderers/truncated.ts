import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@moonshot-ai/pi-tui';

import { TAIL_FULL_WRAP_MAX_CHARS } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

const DEFAULT_INDENT = 2;

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

/**
 * Component that renders tool output with wrap-aware line truncation.
 * Uses pi-tui's Text component to compute actual visual wrapped lines,
 * then caps at PREVIEW_LINES. This handles long single-line output (e.g.
 * JSON blobs) that would otherwise wrap to dozens of visual rows.
 */
export class TruncatedOutputComponent implements Component {
  private textComponent: Text;
  private readonly plainOutput: string;
  private readonly isError: boolean;
  private readonly successColor: keyof ColorPalette;
  private expanded: boolean;
  private readonly maxLines: number;
  private readonly indent: number;
  private readonly expandHint: boolean;
  private readonly tail: boolean;
  private tailCache?: { width: number; rows: string[]; total: number };

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
      indent?: number;
      // When false, the truncation footer omits the "ctrl+o to expand" promise
      // (for contexts whose output is fixed-truncated and never expands).
      expandHint?: boolean;
      // When true, collapsed rendering keeps the latest visual rows instead of
      // the first rows. This is useful for live output from a running command.
      tail?: boolean;
      // Foreground colour for successful (non-error) output. Defaults to
      // `textDim`; Bash passes `textMuted` so its result sits one shade below
      // the `textDim` command. Error output always uses `error`.
      color?: keyof ColorPalette;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.expandHint = options.expandHint ?? true;
    this.tail = options.tail ?? false;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    this.plainOutput = cleaned;
    this.isError = options.isError ?? false;
    this.successColor = options.color ?? 'textDim';
    this.textComponent = new Text(this.colorize(cleaned), this.indent, 0);
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {
    // Both caches are width-dependent; invalidate on terminal resize.
    this.tailCache = undefined;
    this.textComponent.invalidate();
  }

  private colorize(text: string): string {
    return this.isError ? currentTheme.fg('error', text) : currentTheme.fg(this.successColor, text);
  }

  private renderHint(width: number, hint: string): string {
    const indentWidth = Math.min(this.indent, Math.max(0, width));
    const hintWidth = Math.max(0, width - indentWidth);
    return ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…'));
  }

  render(width: number): string[] {
    if (!this.expanded && this.tail && this.plainOutput.length > TAIL_FULL_WRAP_MAX_CHARS) {
      return this.renderBoundedTail(width);
    }

    const contentLines = this.textComponent.render(width);

    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const remaining = contentLines.length - this.maxLines;
    if (this.tail) {
      const shown = contentLines.slice(contentLines.length - this.maxLines);
      return [this.renderHint(width, this.tailHint(remaining)), ...shown];
    }

    const shown = contentLines.slice(0, this.maxLines);
    const hint = this.expandHint
      ? `... (${String(remaining)} more lines, ctrl+o to expand)`
      : `... (${String(remaining)} more lines)`;
    return [...shown, this.renderHint(width, hint)];
  }

  private tailHint(remaining: number): string {
    return this.expandHint
      ? `... (${String(remaining)} earlier lines, ctrl+o to expand)`
      : `... (${String(remaining)} earlier lines)`;
  }

  // Large-output collapsed tail: count visual rows per logical line (cheap —
  // a fitting line cannot be split), wrap only the trailing lines that cover
  // the preview. Must render identically to wrapping everything and slicing
  // the last maxLines rows.
  private renderBoundedTail(width: number): string[] {
    if (this.tailCache === undefined || this.tailCache.width !== width) {
      this.tailCache = this.computeBoundedTail(width);
    }
    const { rows, total } = this.tailCache;
    if (total <= this.maxLines) {
      return rows;
    }
    const shown = rows.slice(rows.length - this.maxLines);
    return [this.renderHint(width, this.tailHint(total - this.maxLines)), ...shown];
  }

  private computeBoundedTail(width: number): { width: number; rows: string[]; total: number } {
    const contentWidth = Math.max(1, width - this.indent * 2);
    // Split on the same line-ending set as wrapTextWithAnsi so the per-line
    // counts match the full wrap.
    const lines = this.plainOutput.split(/\r\n|\r|\n/);
    const rowCounts: number[] = [];
    let total = 0;
    for (const line of lines) {
      // Mirror Text.render's tab expansion so the count matches the real wrap.
      const normalized = line.includes('\t') ? line.replaceAll('\t', '   ') : line;
      const rows =
        visibleWidth(normalized) <= contentWidth
          ? 1
          : wrapTextWithAnsi(normalized, contentWidth).length;
      rowCounts.push(rows);
      total += rows;
    }
    let kept = 0;
    let keptRows = 0;
    for (let i = lines.length - 1; i >= 0 && keptRows < this.maxLines; i--) {
      keptRows += rowCounts[i]!;
      kept++;
    }
    const tailText = new Text(this.colorize(lines.slice(lines.length - kept).join('\n')), this.indent, 0);
    return { width, rows: tailText.render(width), total };
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
    }),
  ];
};
