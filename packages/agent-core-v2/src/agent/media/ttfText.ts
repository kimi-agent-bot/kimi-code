import { readFile } from 'node:fs/promises';

import * as opentypeModule from 'opentype.js';
import type { OpenTypeFont, OpenTypePathCommand } from 'opentype.js';

export const ANNOTATION_FONT_ENV_VAR = 'KIMI_IMAGE_ZOOM_FONT';

export type AnnotationFont = OpenTypeFont;

type OpenTypeParse = (buffer: ArrayBuffer) => OpenTypeFont;

const parseOpenTypeFont: OpenTypeParse =
  typeof opentypeModule.parse === 'function'
    ? opentypeModule.parse
    : (opentypeModule.default as unknown as { readonly parse: OpenTypeParse }).parse;

export interface TtfTargetImage {
  readonly width: number;
  readonly height: number;
  setPixelColor(color: number, x: number, y: number): unknown;
}

const CANDIDATE_FONT_PATHS: readonly string[] = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/STHeiti Light.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
];

let cachedFontKey: string | undefined;
let cachedFont: Promise<AnnotationFont | undefined> | undefined;

export function resolveAnnotationFont(): Promise<AnnotationFont | undefined> {
  const key = process.env[ANNOTATION_FONT_ENV_VAR] ?? '';
  if (cachedFont === undefined || cachedFontKey !== key) {
    cachedFontKey = key;
    cachedFont = loadAnnotationFont(key);
  }
  return cachedFont;
}

async function loadAnnotationFont(explicitPath: string): Promise<AnnotationFont | undefined> {
  const candidates =
    explicitPath.length > 0 ? [explicitPath, ...CANDIDATE_FONT_PATHS] : CANDIDATE_FONT_PATHS;
  for (const candidate of candidates) {
    const font = await tryParseFontFile(candidate);
    if (font !== undefined) return font;
  }
  return undefined;
}

async function tryParseFontFile(path: string): Promise<AnnotationFont | undefined> {
  try {
    const bytes = await readFile(path);
    const copy = new Uint8Array(bytes);
    const font = parseOpenTypeFont(copy.buffer);
    if (!Number.isFinite(font.unitsPerEm) || font.unitsPerEm <= 0) return undefined;
    return font;
  } catch {
    return undefined;
  }
}

export interface TtfTextMetrics {
  readonly width: number;
  readonly height: number;
  readonly ascent: number;
  readonly descent: number;
}

export function measureTtfText(font: AnnotationFont, text: string, size: number): TtfTextMetrics {
  const scale = size / font.unitsPerEm;
  const ascent = font.ascender * scale;
  const descent = -font.descender * scale;
  return {
    width: font.getAdvanceWidth(text, size),
    height: ascent + descent,
    ascent,
    descent,
  };
}

export interface DrawTtfTextOptions {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly size: number;
  readonly color: number;
  readonly background?: number;
}

export function drawTtfText(
  image: TtfTargetImage,
  font: AnnotationFont,
  opts: DrawTtfTextOptions,
): void {
  if (opts.text.length === 0 || opts.size <= 0) return;
  const metrics = measureTtfText(font, opts.text, opts.size);
  if (opts.background !== undefined) {
    fillBackground(image, opts.x, opts.y, metrics.width, metrics.height, opts.background);
  }
  const baseline = opts.y + metrics.ascent;
  const path = font.getPath(opts.text, opts.x, baseline, opts.size);
  fillPolygons(image, flattenPath(path.commands), opts.color);
}

function fillBackground(
  image: TtfTargetImage,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(image.width, Math.ceil(x + width));
  const y1 = Math.min(image.height, Math.ceil(y + height));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      image.setPixelColor(color, px, py);
    }
  }
}

interface FlatPoint {
  readonly x: number;
  readonly y: number;
}

function flattenPath(commands: readonly OpenTypePathCommand[]): FlatPoint[][] {
  const polygons: FlatPoint[][] = [];
  let contour: FlatPoint[] = [];
  let cx = 0;
  let cy = 0;
  const closeContour = (): void => {
    if (contour.length >= 2) polygons.push(contour);
    contour = [];
  };
  for (const command of commands) {
    switch (command.type) {
      case 'M': {
        closeContour();
        cx = command.x ?? 0;
        cy = command.y ?? 0;
        contour = [{ x: cx, y: cy }];
        break;
      }
      case 'L': {
        cx = command.x ?? cx;
        cy = command.y ?? cy;
        contour.push({ x: cx, y: cy });
        break;
      }
      case 'Q': {
        const qx = command.x ?? cx;
        const qy = command.y ?? cy;
        const c1x = command.x1 ?? cx;
        const c1y = command.y1 ?? cy;
        const segments = 8;
        for (let i = 1; i <= segments; i++) {
          const t = i / segments;
          const mt = 1 - t;
          contour.push({
            x: mt * mt * cx + 2 * mt * t * c1x + t * t * qx,
            y: mt * mt * cy + 2 * mt * t * c1y + t * t * qy,
          });
        }
        cx = qx;
        cy = qy;
        break;
      }
      case 'C': {
        const ex = command.x ?? cx;
        const ey = command.y ?? cy;
        const c1x = command.x1 ?? cx;
        const c1y = command.y1 ?? cy;
        const c2x = command.x2 ?? ex;
        const c2y = command.y2 ?? ey;
        const segments = 10;
        for (let i = 1; i <= segments; i++) {
          const t = i / segments;
          const mt = 1 - t;
          contour.push({
            x: mt * mt * mt * cx + 3 * mt * mt * t * c1x + 3 * mt * t * c2x + t * t * t * ex,
            y: mt * mt * mt * cy + 3 * mt * mt * t * c1y + 3 * mt * t * c2y + t * t * t * ey,
          });
        }
        cx = ex;
        cy = ey;
        break;
      }
      case 'Z': {
        closeContour();
        break;
      }
    }
  }
  closeContour();
  return polygons;
}

function fillPolygons(image: TtfTargetImage, polygons: readonly FlatPoint[][], color: number): void {
  const edges: number[] = [];
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!;
      const b = polygon[(i + 1) % polygon.length]!;
      if (a.y === b.y) continue;
      edges.push(a.x, a.y, b.x, b.y);
      minY = Math.min(minY, a.y, b.y);
      maxY = Math.max(maxY, a.y, b.y);
    }
  }
  if (edges.length === 0) return;
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(image.height - 1, Math.ceil(maxY) - 1);
  const crossings: number[] = [];
  for (let y = yStart; y <= yEnd; y++) {
    const scanY = y + 0.5;
    crossings.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const y1 = edges[e + 1]!;
      const y2 = edges[e + 3]!;
      if (scanY < Math.min(y1, y2) || scanY >= Math.max(y1, y2)) continue;
      const x1 = edges[e]!;
      const x2 = edges[e + 2]!;
      crossings.push(x1 + ((scanY - y1) * (x2 - x1)) / (y2 - y1));
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const xStart = Math.max(0, Math.ceil(crossings[i]! - 0.5));
      const xEnd = Math.min(image.width - 1, Math.floor(crossings[i + 1]! - 0.5));
      for (let x = xStart; x <= xEnd; x++) {
        image.setPixelColor(color, x, y);
      }
    }
  }
}
