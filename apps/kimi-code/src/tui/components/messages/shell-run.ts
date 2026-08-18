import { Container, Text, visibleWidth, wrapTextWithAnsi, type Component } from '@moonshot-ai/pi-tui';

import { SHELL_OUTPUT_TAIL_LINES } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

import { formatBashOutputForDisplay, sanitizeShellOutput } from '#/tui/utils/shell-output';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

const TIMER_INTERVAL_MS = 1000;
// Cap the live running buffer so a command that spews output for minutes can't
// grow memory without bound or make every render re-strip a multi-MB string.
// Only affects the transient running tail; the final view uses the full
// captured stdout/stderr passed to finish().
const MAX_COMBINED_CHARS = 256 * 1024;
const KEEP_COMBINED_CHARS = 64 * 1024;

const BODY_INDENT = 2;

/**
 * The running card's output body. Collapsed, it renders the last
 * SHELL_OUTPUT_TAIL_LINES visual rows — wrap-aware, so the card has the same
 * height and content as the finished collapsed view when the command ends.
 * The logical-line pre-slice bounds the wrap work per flush no matter how
 * large the live buffer gets (the last 20 visual rows always sit within the
 * last 20 logical lines). Expanded, it renders the whole buffer.
 */
class RunningOutputText implements Component {
  private text = '';
  private expanded = false;
  private cache?: { width: number; lines: string[] };

  setContent(text: string, expanded: boolean): void {
    if (this.text === text && this.expanded === expanded) return;
    this.text = text;
    this.expanded = expanded;
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache === undefined || this.cache.width !== width) {
      this.cache = { width, lines: this.computeLines(width) };
    }
    return this.cache.lines;
  }

  private computeLines(width: number): string[] {
    // Match the finished view's wrap budget exactly: TruncatedOutputComponent
    // renders through a Text with paddingX = BODY_INDENT on both sides.
    const contentWidth = Math.max(1, width - BODY_INDENT * 2);
    const collapsedSource = this.text
      .split('\n')
      .slice(-SHELL_OUTPUT_TAIL_LINES)
      .join('\n');
    const source = (this.expanded ? this.text : collapsedSource).replaceAll('\t', '   ');
    const wrapped = wrapTextWithAnsi(source, contentWidth);
    const rows = this.expanded ? wrapped : wrapped.slice(-SHELL_OUTPUT_TAIL_LINES);
    return rows.map((row) => {
      const line = ' '.repeat(BODY_INDENT) + currentTheme.fg('textDim', row);
      return line + ' '.repeat(Math.max(0, width - visibleWidth(line)));
    });
  }
}

/**
 * Live view for a user-initiated `!` shell command. Two phases:
 *
 *  - running: dim, ANSI-stripped tail of the combined output (the last
 *    SHELL_OUTPUT_TAIL_LINES visual rows; the full buffer when expanded via
 *    ctrl+o), a `+N lines` overflow marker, an elapsed `(Xs)` timer that
 *    ticks every second, and a `(ctrl+b to run in background)` hint.
 *  - finished: the combined output through the shared TruncatedOutputComponent
 *    in tail mode — collapsed to the last SHELL_OUTPUT_TAIL_LINES visual rows
 *    with an expand hint, expanded to the full output by ctrl+o. stderr stays
 *    red on failure / grey on success (baked in by formatBashOutputForDisplay).
 *
 * Hardened so a misbehaving command can never crash the TUI: the running
 * buffer is capped, and every render/render-request path swallows errors.
 */
export class ShellRunComponent extends Container {
  private readonly bodyComponent = new RunningOutputText();
  private readonly chromeComponent: Text;
  private resultComponent?: TruncatedOutputComponent;
  private combined = '';
  private running = true;
  private backgrounded = false;
  private disposed = false;
  private expanded = false;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly requestRender: () => void) {
    super();
    this.chromeComponent = new Text('', 0, 0);
    this.addChild(this.bodyComponent);
    this.addChild(this.chromeComponent);
    this.updateRunningView();
    this.timer = setInterval(() => this.tick(), TIMER_INTERVAL_MS);
  }

  append(text: string): void {
    if (this.disposed || !this.running || text.length === 0) return;
    this.combined += text;
    if (this.combined.length > MAX_COMBINED_CHARS) {
      this.combined = this.combined.slice(-KEEP_COMBINED_CHARS);
    }
    this.flush();
  }

  finish(stdout: string, stderr: string, isError?: boolean): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.clearTimer();
    try {
      this.resultComponent = new TruncatedOutputComponent(
        formatBashOutputForDisplay(stdout, stderr, isError),
        {
          expanded: this.expanded,
          // The stream colours are already baked into the formatted text, so
          // the component must not re-colour the whole block as an error.
          isError: false,
          maxLines: SHELL_OUTPUT_TAIL_LINES,
          tail: true,
          expandHint: true,
          color: 'textMuted',
        },
      );
      this.clear();
      this.addChild(this.resultComponent);
    } catch {
      // finish() runs in a promise continuation — an escaping error would
      // surface as an unhandled rejection.
    }
    this.flush();
  }

  finishBackgrounded(): void {
    if (this.disposed || !this.running) return;
    this.running = false;
    this.backgrounded = true;
    this.clearTimer();
    try {
      this.clear();
      this.addChild(new Text(`  ${currentTheme.fg('textDim', 'Moved to background.')}`, 0, 0));
    } catch {
      // Must not throw back into the key/event handler that triggered this.
    }
    this.flush();
  }

  setExpanded(expanded: boolean): void {
    if (this.disposed || this.expanded === expanded) return;
    this.expanded = expanded;
    this.resultComponent?.setExpanded(expanded);
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private tick(): void {
    if (!this.running) return;
    this.flush();
  }

  private flush(): void {
    if (this.disposed) return;
    try {
      if (this.running) {
        this.updateRunningView();
      }
      this.requestRender();
    } catch {
      // Never let a render/render-request error escape into a timer or event
      // handler — an uncaught exception there can take down the whole TUI.
    }
  }

  private updateRunningView(): void {
    try {
      const dim = (s: string): string => currentTheme.fg('textDim', s);
      const trimmed = sanitizeShellOutput(this.combined).trimEnd();
      this.bodyComponent.setContent(trimmed.length === 0 ? 'Running…' : trimmed, this.expanded);
      let extra = 0;
      if (!this.expanded && trimmed.length > 0) {
        extra = Math.max(0, trimmed.split('\n').length - SHELL_OUTPUT_TAIL_LINES);
      }
      const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
      const timing = `  ${dim(`${extra > 0 ? `+${String(extra)} lines ` : ''}(${String(elapsed)}s)`)}`;
      const hint = `  ${dim('(ctrl+b to run in background)')}`;
      this.chromeComponent.setText(`${timing}\n${hint}`);
    } catch {
      // The fallback only assigns fields, so it cannot throw again.
      this.bodyComponent.setContent('(output unavailable)', this.expanded);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
