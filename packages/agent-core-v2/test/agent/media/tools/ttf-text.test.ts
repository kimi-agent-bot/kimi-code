import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Jimp } from 'jimp';
import { afterEach, describe, expect, it } from 'vitest';

import { zoomImageForModel } from '#/agent/media/image-compress';
import {
  ANNOTATION_FONT_ENV_VAR,
  drawTtfText,
  measureTtfText,
  resolveAnnotationFont,
} from '#/agent/media/ttfText';

const DEMO_FONT_PATH =
  '/mira/home/spaces/01a008f0-61d2-7e33-89d2-42b7febbb813/runtime/sessions/' +
  '01a047e5-b0c3-7918-9369-857831059d5c/workspace/demo/assets/noto-sans-sc.ttf';

const demoFontAvailable = existsSync(DEMO_FONT_PATH);

const savedEnvFont = process.env[ANNOTATION_FONT_ENV_VAR];

afterEach(() => {
  if (savedEnvFont === undefined) {
    delete process.env[ANNOTATION_FONT_ENV_VAR];
  } else {
    process.env[ANNOTATION_FONT_ENV_VAR] = savedEnvFont;
  }
});

async function noisePng(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  image.scan((x, y, idx) => {
    const data = image.bitmap.data;
    data[idx] = (x * 31 + y * 17) % 256;
    data[idx + 1] = (x * 13 + y * 47 + 29) % 256;
    data[idx + 2] = (x * 71 + y * 7 + 101) % 256;
    data[idx + 3] = 255;
  });
  return Buffer.from(await image.getBuffer('image/png'));
}

interface ScannableImage {
  readonly bitmap: { readonly data: Buffer };
  scan(callback: (x: number, y: number, idx: number) => void): unknown;
}

function countInk(image: ScannableImage): number {
  let ink = 0;
  image.scan((x, y, idx) => {
    const data = image.bitmap.data;
    if (data[idx]! > 200 && data[idx + 1]! > 200 && data[idx + 2]! > 200) ink++;
  });
  return ink;
}

describe.skipIf(!demoFontAvailable)('ttf annotation text', () => {
  it('resolves the demo font through the env var and measures CJK text', async () => {
    process.env[ANNOTATION_FONT_ENV_VAR] = DEMO_FONT_PATH;
    const font = await resolveAnnotationFont();
    expect(font).toBeDefined();
    const metrics = measureTtfText(font!, '知春路', 20);
    expect(metrics.width).toBeGreaterThan(40);
    expect(metrics.height).toBeGreaterThan(20);
    expect(metrics.ascent).toBeGreaterThan(0);
    expect(metrics.descent).toBeGreaterThan(0);
  });

  it('renders CJK glyphs instead of fallback boxes', async () => {
    process.env[ANNOTATION_FONT_ENV_VAR] = DEMO_FONT_PATH;
    const font = await resolveAnnotationFont();
    expect(font).toBeDefined();
    const text = '知春路 × 科学院南路';
    const image = new Jimp({ width: 400, height: 120, color: 0x3366ccff });
    drawTtfText(image, font!, { x: 8, y: 8, text, size: 20, color: 0xffffffff });

    const ink = countInk(image);
    expect(ink).toBeGreaterThan(400);

    const fallback = new Jimp({ width: 400, height: 120, color: 0x3366ccff });
    const [{ loadFont }, fonts] = await Promise.all([import('jimp'), import('jimp/fonts')]);
    const bitmapFont = await loadFont(fonts.SANS_16_WHITE);
    fallback.print({ font: bitmapFont, x: 8, y: 8, text });

    let differentPixels = 0;
    image.scan((x, y, idx) => {
      const a = image.bitmap.data;
      const b = fallback.bitmap.data;
      if (a[idx] !== b[idx] || a[idx + 1] !== b[idx + 1] || a[idx + 2] !== b[idx + 2]) {
        differentPixels++;
      }
    });
    expect(differentPixels).toBeGreaterThan(500);
  });

  it('fills the band behind the text with the background color', async () => {
    process.env[ANNOTATION_FONT_ENV_VAR] = DEMO_FONT_PATH;
    const font = await resolveAnnotationFont();
    expect(font).toBeDefined();
    const image = new Jimp({ width: 400, height: 120, color: 0x3366ccff });
    drawTtfText(image, font!, {
      x: 20,
      y: 20,
      text: '知春路',
      size: 20,
      color: 0xffffffff,
      background: 0x112233ff,
    });
    expect(image.getPixelColor(20, 20)).toBe(0x112233ff);
    expect(image.getPixelColor(39, 20)).toBe(0x112233ff);
    expect(countInk(image)).toBeGreaterThan(100);
  });

  it('draws a Chinese label through zoomImageForModel', async () => {
    process.env[ANNOTATION_FONT_ENV_VAR] = DEMO_FONT_PATH;
    const source = await noisePng(300, 200);
    const withLabel = await zoomImageForModel(source, 'image/png', {
      annotations: [{ type: 'label', x: 10, y: 10, text: '知春路' }],
    });
    const withoutLabel = await zoomImageForModel(source, 'image/png', {});
    expect(withLabel.ok).toBe(true);
    expect(withoutLabel.ok).toBe(true);
    if (withLabel.ok && withoutLabel.ok) {
      expect(Buffer.from(withLabel.data).equals(Buffer.from(withoutLabel.data))).toBe(false);
    }
  });
});

describe('annotation font fallback', () => {
  it('does not throw when the env var points at a missing file', async () => {
    process.env[ANNOTATION_FONT_ENV_VAR] = '/nonexistent/path/no-such-font.ttf';
    const font = await resolveAnnotationFont();
    expect(font === undefined || typeof font.unitsPerEm === 'number').toBe(true);
  });

  it('does not throw when the env var points at an unparseable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ttf-text-'));
    try {
      const bogus = join(dir, 'not-a-font.ttf');
      await writeFile(bogus, 'this is not a font file at all');
      process.env[ANNOTATION_FONT_ENV_VAR] = bogus;
      const font = await resolveAnnotationFont();
      expect(font === undefined || typeof font.unitsPerEm === 'number').toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still draws labels when no TTF font resolves', async () => {
    process.env[ANNOTATION_FONT_ENV_VAR] = '/nonexistent/path/no-such-font.ttf';
    const font = await resolveAnnotationFont();
    if (font !== undefined) return;
    const source = await noisePng(200, 120);
    const withLabel = await zoomImageForModel(source, 'image/png', {
      annotations: [{ type: 'label', x: 5, y: 5, text: '知春路' }],
    });
    const withoutLabel = await zoomImageForModel(source, 'image/png', {});
    expect(withLabel.ok).toBe(true);
    expect(withoutLabel.ok).toBe(true);
    if (withLabel.ok && withoutLabel.ok) {
      expect(Buffer.from(withLabel.data).equals(Buffer.from(withoutLabel.data))).toBe(false);
    }
  });
});
