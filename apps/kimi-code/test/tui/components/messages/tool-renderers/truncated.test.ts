import { Text, visibleWidth, wrapTextWithAnsi } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { TruncatedOutputComponent } from '#/tui/components/messages/tool-renderers/truncated';
import { TAIL_FULL_WRAP_MAX_CHARS } from '#/tui/constant/rendering';


function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('TruncatedOutputComponent', () => {
  it('indents content and the truncation hint by the configured amount', () => {
    const component = new TruncatedOutputComponent(['a', 'b', 'c', 'd', 'e'].join('\n'), {
      expanded: false,
      isError: false,
      maxLines: 2,
      indent: 6,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]?.startsWith('      a')).toBe(true);
    expect(lines[1]?.startsWith('      b')).toBe(true);
    expect(lines[2]).toBe('      ... (3 more lines, ctrl+o to expand)');
  });

  it('defaults to a two-space indent for both content and hint', () => {
    const component = new TruncatedOutputComponent('x\ny\nz', {
      expanded: false,
      isError: false,
      maxLines: 1,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]?.startsWith('  x')).toBe(true);
    expect(lines[1]).toBe('  ... (2 more lines, ctrl+o to expand)');
  });

  it('omits the ctrl+o promise when expandHint is false', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: false,
      isError: false,
      maxLines: 2,
      indent: 4,
      expandHint: false,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[2]).toBe('    ... (2 more lines)');
  });

  it('renders all lines without a hint when expanded', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: true,
      isError: false,
      maxLines: 2,
      indent: 4,
    });

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('d');
    expect(out).not.toContain('more lines, ctrl+o');
  });

  it('keeps the truncation footer within the requested render width', () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines: 3,
      indent: 2,
    });

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('shows a ctrl+o hint in tail mode when expandHint is true', () => {
    const component = new TruncatedOutputComponent(['a', 'b', 'c', 'd', 'e'].join('\n'), {
      expanded: false,
      isError: false,
      maxLines: 2,
      tail: true,
      expandHint: true,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]).toBe('  ... (3 earlier lines, ctrl+o to expand)');
    expect(lines[1]?.trimEnd()).toBe('  d');
    expect(lines[2]?.trimEnd()).toBe('  e');
  });

  it('omits the ctrl+o hint in tail mode when expandHint is false', () => {
    const component = new TruncatedOutputComponent(['a', 'b', 'c', 'd', 'e'].join('\n'), {
      expanded: false,
      isError: false,
      maxLines: 2,
      tail: true,
      expandHint: false,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]).toBe('  ... (3 earlier lines)');
  });

  it('toggles between collapsed and expanded rendering via setExpanded', () => {
    const component = new TruncatedOutputComponent(['a', 'b', 'c', 'd'].join('\n'), {
      expanded: false,
      isError: false,
      maxLines: 2,
    });

    expect(strip(component.render(80).join('\n'))).toContain('2 more lines');

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toMatch(/^ {2}d\s*$/m);
    expect(expanded).not.toContain('more lines');

    component.setExpanded(false);
    expect(strip(component.render(80).join('\n'))).toContain('2 more lines');
  });

  it('keeps the hidden-line count and tail rows exact for large wrapping output', () => {
    // Output above the full-wrap limit: the collapsed tail must be computed
    // from a bounded prefix of the wrap work, yet stay identical to wrapping
    // everything and slicing the last maxLines visual rows.
    const lineCount = Math.ceil(TAIL_FULL_WRAP_MAX_CHARS / 150) + 20;
    const output = Array.from({ length: lineCount }, (_, i) =>
      i % 5 === 0 ? `short ${String(i)}` : `line-${String(i)}-${'x'.repeat(200)}`,
    ).join('\n');
    expect(output.length).toBeGreaterThan(TAIL_FULL_WRAP_MAX_CHARS);

    const width = 80;
    const maxLines = 20;
    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines,
      tail: true,
      expandHint: true,
    });

    const expected = wrapTextWithAnsi(output, width - 4);
    const lines = strip(component.render(width).join('\n')).split('\n');
    expect(lines).toHaveLength(maxLines + 1);
    expect(lines[0]).toBe(`  ... (${String(expected.length - maxLines)} earlier lines, ctrl+o to expand)`);
    for (const [i, row] of expected.slice(-maxLines).entries()) {
      expect(lines[i + 1]?.trimEnd()).toBe(`  ${row}`.trimEnd());
    }
    expect(lines.join('\n')).not.toContain('line-0-');
  });

  it('counts tabbed long lines the same way the full wrap does', () => {
    // `Text.render` expands tabs to three spaces before wrapping; the bounded
    // path must mirror that, or the hidden-line count drifts from the real
    // wrap. Some lines place the tab at a wrap boundary so a raw-tab count
    // produces a different row total than a space-normalised one.
    const lineCount = Math.ceil(TAIL_FULL_WRAP_MAX_CHARS / 200) + 20;
    const output = Array.from({ length: lineCount }, (_, i) =>
      i % 97 === 0
        ? `${'a'.repeat(74)}\t${'x'.repeat(76)}`
        : `line-${String(i)}-\t${'x'.repeat(200)}`,
    ).join('\n');
    expect(output.length).toBeGreaterThan(TAIL_FULL_WRAP_MAX_CHARS);

    const width = 80;
    const maxLines = 20;
    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines,
      tail: true,
      expandHint: true,
    });

    // The full-wrap oracle: the same primitive the unbounded path renders with.
    const expected = new Text(output, 2, 0).render(width);
    const lines = strip(component.render(width).join('\n')).split('\n');
    expect(lines).toHaveLength(maxLines + 1);
    expect(lines[0]).toBe(
      `  ... (${String(expected.length - maxLines)} earlier lines, ctrl+o to expand)`,
    );
    for (const [i, row] of expected.slice(-maxLines).entries()) {
      expect(lines[i + 1]?.trimEnd()).toBe(row.trimEnd());
    }
  });

  it('counts mixed line endings the same way the full wrap does', () => {
    // wrapTextWithAnsi splits on \r\n, \r and \n; the bounded count must too.
    const separators = ['\n', '\r\n', '\r'];
    const parts: string[] = [];
    let length = 0;
    for (let i = 0; length <= TAIL_FULL_WRAP_MAX_CHARS; i++) {
      const part = i % 7 === 0 ? `s-${String(i)}` : `part-${String(i)}-${'y'.repeat(200)}`;
      parts.push(part);
      length += part.length + 1;
    }
    let output = parts[0]!;
    for (const [i, part] of parts.slice(1).entries()) {
      output += separators[i % separators.length]! + part;
    }

    const width = 80;
    const maxLines = 20;
    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines,
      tail: true,
      expandHint: true,
    });

    const expected = wrapTextWithAnsi(output, width - 4);
    const lines = strip(component.render(width).join('\n')).split('\n');
    expect(lines[0]).toBe(`  ... (${String(expected.length - maxLines)} earlier lines, ctrl+o to expand)`);
    for (const [i, row] of expected.slice(-maxLines).entries()) {
      expect(lines[i + 1]?.trimEnd()).toBe(`  ${row}`.trimEnd());
    }
  });

  it('renders the complete output when a large collapsed tail is expanded', () => {
    const lineCount = Math.ceil(TAIL_FULL_WRAP_MAX_CHARS / 150) + 20;
    const output = Array.from(
      { length: lineCount },
      (_, i) => `line-${String(i)}-${'x'.repeat(200)}`,
    ).join('\n');

    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines: 20,
      tail: true,
      expandHint: true,
    });

    component.setExpanded(true);
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line-0-');
    expect(out).toContain(`line-${String(lineCount - 1)}-`);
    expect(out).not.toContain('earlier lines');
  });

  it('renders output verbatim, including literal <system> text in file content', () => {
    // Tool metadata no longer travels inside `output` (it rides the result's
    // `note` side channel), so the renderer must not eat user data that
    // merely contains the literal tag.
    const component = new TruncatedOutputComponent(
      '<system>literal text from a user file</system>\n<image path="/tmp/x.png">',
      { expanded: true, isError: false },
    );
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('<system>literal text from a user file</system>');
    expect(out).toContain('<image path="/tmp/x.png">');
  });
});
