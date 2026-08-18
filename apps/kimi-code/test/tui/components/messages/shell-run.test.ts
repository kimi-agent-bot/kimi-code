import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';

import { ShellRunComponent } from '#/tui/components/messages/shell-run';
import { TAIL_FULL_WRAP_MAX_CHARS } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

function stripTheme(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('ShellRunComponent hardening', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    // Always clear the 1s timer so it can't keep the test process alive or
    // fire requestRender after the test ends.
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  it('caps the running buffer and never throws on huge streaming output', () => {
    const c = create();
    const chunk = 'x'.repeat(50_000);
    expect(() => {
      for (let i = 0; i < 20; i++) c.append(chunk);
      c.render(100);
    }).not.toThrow();
  });

  it('finish switches to the final view and ignores later appends', () => {
    const c = create();
    c.finish('final output', '', false);
    c.append('should be ignored');
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('final output');
    expect(rendered).not.toContain('should be ignored');
  });

  it('finishBackgrounded renders the background hint', () => {
    const c = create();
    c.finishBackgrounded();
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('Moved to background.');
  });

  it('append / finish are no-ops after dispose', () => {
    const c = create();
    c.dispose();
    expect(() => {
      c.append('late');
      c.finish('late', '', false);
      c.finishBackgrounded();
      c.render(100);
    }).not.toThrow();
  });

  it('does not throw when the render callback throws', () => {
    const c = new ShellRunComponent(() => {
      throw new Error('render failed');
    });
    component = c;
    expect(() => {
      c.append('output');
      c.render(100);
    }).not.toThrow();
  });
});

describe('ShellRunComponent collapse/expand', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  function lines(count: number, fill = 0): string {
    return Array.from({ length: count }, (_, i) =>
      fill > 0 ? `line ${String(i + 1)} ${'x'.repeat(fill)}` : `line ${String(i + 1)}`,
    ).join('\n');
  }

  it('keeps the running tail at 20 visual rows for wrapping output', () => {
    const c = create();
    c.append(lines(30, 300));
    const rendered = c.render(100);
    // 20 visual body rows + timing + hint — not 20 logical lines (~80 rows).
    expect(rendered).toHaveLength(22);
    expect(stripTheme(rendered.join('\n'))).toContain('+10 lines');
  });

  it('shows the same output rows before and after finish', () => {
    const c = create();
    const output = lines(30, 300);
    c.append(output);
    const runningRows = c.render(100).map(stripTheme);

    c.finish(output, '', false);
    const finishedRows = c.render(100).map(stripTheme);

    // Running: 20 body rows + timing + hint. Finished: marker + the same 20
    // body rows — the visible output must not change when the command ends.
    expect(finishedRows.slice(1)).toEqual(runningRows.slice(0, 20));
  });

  it('shows the last 20 lines with an overflow count while running', () => {
    const c = create();
    c.append(lines(30));
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('+10 lines');
    expect(rendered).toContain('line 11');
    expect(rendered).toContain('line 30');
    expect(rendered).not.toContain('line 10');
  });

  it('renders the full live buffer while running when expanded', () => {
    const c = create();
    c.append(lines(30));
    c.setExpanded(true);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toMatch(/\bline 1\b/);
    expect(rendered).toContain('line 30');
    expect(rendered).not.toContain('+10 lines');
    expect(rendered).toContain('(ctrl+b to run in background)');
  });

  it('keeps appending to the expanded running view', () => {
    const c = create();
    c.setExpanded(true);
    c.append(lines(30));
    c.append('\nline 31');
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toMatch(/\bline 1\b/);
    expect(rendered).toContain('line 31');
  });

  it('collapses finished output to the last 20 lines with an expand hint', () => {
    const c = create();
    c.finish(lines(30), '', false);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('... (10 earlier lines, ctrl+o to expand)');
    expect(rendered).toContain('line 11');
    expect(rendered).toContain('line 30');
    expect(rendered).not.toContain('line 10');
  });

  it('renders the (no output) fallback for empty finished output', () => {
    const c = create();
    c.finish('', '', false);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('(no output)');
    expect(rendered).not.toContain('earlier lines');
  });

  it('renders short finished output in full without a marker', () => {
    const c = create();
    c.finish(lines(20), '', false);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toMatch(/\bline 1\b/);
    expect(rendered).toContain('line 20');
    expect(rendered).not.toContain('earlier lines');
  });

  it('expands and collapses finished output via setExpanded', () => {
    const c = create();
    c.finish(lines(30), '', false);

    c.setExpanded(true);
    const expanded = stripTheme(c.render(100).join('\n'));
    expect(expanded).toMatch(/\bline 1\b/);
    expect(expanded).toContain('line 30');
    expect(expanded).not.toContain('earlier lines');

    c.setExpanded(false);
    const collapsed = stripTheme(c.render(100).join('\n'));
    expect(collapsed).toContain('... (10 earlier lines, ctrl+o to expand)');
    expect(collapsed).not.toContain('line 10');
  });

  it('carries the running expanded state into the finished view', () => {
    const c = create();
    c.setExpanded(true);
    c.finish(lines(30), '', false);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toMatch(/\bline 1\b/);
    expect(rendered).not.toContain('earlier lines');
  });

  it('keeps stderr error colors in the collapsed tail above the full-wrap limit', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const c = create();
      const stdoutLines = Math.ceil(TAIL_FULL_WRAP_MAX_CHARS / 100) + 30;
      const stdout = Array.from(
        { length: stdoutLines },
        (_, i) => `out ${String(i + 1)} ${'o'.repeat(90)}`,
      ).join('\n');
      const stderr = Array.from({ length: 30 }, (_, i) => `err ${String(i + 1)}`).join('\n');

      c.finish(stdout, stderr, true);

      // The collapsed tail is sliced from the formatted (pre-colored) output;
      // the error color must survive the slice.
      const errorOpen = currentTheme.fg('error', 'probe').split('probe')[0]!;
      expect(errorOpen).toContain('\u001B[');
      const rendered = c.render(100);
      const tailRow = rendered.find((line) => line.includes('err 30'));
      expect(tailRow).toBeDefined();
      expect(tailRow).toContain(errorOpen);
      expect(stripTheme(rendered.join('\n'))).toContain('earlier lines');
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('renders the capped buffer without throwing while expanded', () => {
    const c = create();
    c.setExpanded(true);
    const chunk = 'x'.repeat(50_000);
    expect(() => {
      for (let i = 0; i < 20; i++) c.append(chunk);
      c.render(100);
    }).not.toThrow();
  });
});
