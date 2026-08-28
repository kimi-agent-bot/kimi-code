import * as posixPath from 'node:path/posix';

import { type ModelCapability } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import { Jimp } from 'jimp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { Runtime } from '#/runtime/runtime';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  ImageZoomInputSchema,
  type ImageZoomInput,
} from '#/agent/tools/image-zoom/image-zoom';
import { ImageZoomTool } from '#/agent/tools/image-zoom/imageZoomTool';
import { setConfiguredReadImageByteBudget } from '#/agent/media/image-compress';
import { registerMediaTools } from '#/agent/media/registerMediaTools';
import { AgentMediaToolsRegistrar } from '#/agent/media/mediaToolsRegistrar';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { EventBusService } from '#/app/event/eventBusService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import type { IAgentProfileService } from '#/agent/profile/profile';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { WorkspaceConfig } from '#/tool/path-access';
import { stubAgentContext } from '../../agentContext/stubs';

const WORKSPACE: WorkspaceConfig = { workspaceDir: '/workspace', additionalDirs: [] };

afterEach(() => {
  setConfiguredReadImageByteBudget(undefined);
});

function capabilities(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: 0,
    ...overrides,
  };
}

const RED = 0xff0000ff;
const GREEN = 0x00ff00ff;
const YELLOW = 0xffff00ff;
const BLUE = 0x0000ffff;

async function quadrantPng(width = 100, height = 80): Promise<Buffer> {
  const image = new Jimp({ width, height, color: RED });
  image.scan((x, y, idx) => {
    const data = image.bitmap.data;
    const right = x >= width / 2;
    const bottom = y >= height / 2;
    const color = right && bottom ? BLUE : right ? GREEN : bottom ? YELLOW : RED;
    data[idx] = (color >>> 24) & 0xff;
    data[idx + 1] = (color >>> 16) & 0xff;
    data[idx + 2] = (color >>> 8) & 0xff;
    data[idx + 3] = color & 0xff;
  });
  return Buffer.from(await image.getBuffer('image/png'));
}

async function solidPng(width: number, height: number, color = 0x3366ccff): Promise<Buffer> {
  return Buffer.from(await new Jimp({ width, height, color }).getBuffer('image/png'));
}

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

function pngHeader(width = 100, height = 80): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

interface FakeFile {
  readonly data: Buffer;
  readonly size?: number;
}

function createTestFs(files: Record<string, FakeFile>): IHostFileSystem {
  const lookup = (path: string): FakeFile | undefined => files[path];
  const missing = (): Error => new Error('ENOENT: no such file or directory');
  return {
    readBytes: vi.fn(async (path: string, n?: number) => {
      const file = lookup(path);
      if (file === undefined) throw missing();
      return n === undefined ? file.data : file.data.subarray(0, n);
    }),
    stat: vi.fn(async (path: string) => {
      const file = lookup(path);
      if (file === undefined) throw missing();
      return {
        isFile: true,
        isDirectory: false,
        size: file.size ?? file.data.length,
      };
    }),
  } as unknown as IHostFileSystem;
}

function createTestEnv(): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/home',
    ready: Promise.resolve(),
  };
}

function runtimeFor(fs: IHostFileSystem, env: IHostEnvironment = createTestEnv()): IAgentRuntimeService {
  const runtime = {
    identity: { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
    capabilities: new Set(['fs'] as const),
    environment: env,
    path: posixPath,
    workspace: { mapRoots: (roots: { workDir: string; additionalDirs?: readonly string[] }) => roots },
    fs,
    status: 'ready',
    onDidChangeStatus: () => ({ dispose: () => {} }),
    dispose: () => {},
  } as unknown as Runtime;
  return {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: (required = []) => required.every((capability) => runtime.capabilities.has(capability)),
    inspect: () => runtime,
    acquire: () => ({
      runtime,
      track: (resource) => resource,
      dispose: () => {},
    }),
  };
}

function fakeMediaStore(
  files: Record<string, { readonly data: Buffer; readonly name: string }>,
): ISessionMediaStore {
  return {
    _serviceBrand: undefined,
    pathFor: () => undefined,
    resolveDisplayPath: async (fileId: string) =>
      files[fileId] === undefined ? undefined : `/session/media/${files[fileId].name}`,
    read: async (fileId: string) =>
      files[fileId] === undefined
        ? undefined
        : { data: files[fileId].data, name: files[fileId].name },
    open: async () => undefined,
    materialize: async () => undefined,
  };
}

function makeTool(
  files: Record<string, FakeFile>,
  caps: ModelCapability = capabilities(),
  mediaStore?: ISessionMediaStore,
  telemetry?: ITelemetryService,
): ImageZoomTool {
  return new ImageZoomTool(runtimeFor(createTestFs(files)), WORKSPACE, caps, mediaStore, telemetry);
}

async function execute(
  tool: ImageZoomTool,
  args: ImageZoomInput,
): Promise<ExecutableToolResult> {
  const execution = tool.resolveExecution(args);
  if (!('execute' in execution)) {
    return execution;
  }
  const ctx: ExecutableToolContext = {
    turnId: 1,
    toolCallId: 'call_zoom',
    signal: new AbortController().signal,
  };
  return execution.execute(ctx);
}

function outputParts(result: ExecutableToolResult): ContentPart[] {
  expect(result.isError).toBeFalsy();
  expect(Array.isArray(result.output)).toBe(true);
  return result.output as ContentPart[];
}

function noteText(result: ExecutableToolResult): string {
  expect(typeof result.note).toBe('string');
  return result.note as string;
}

function imageDataUrl(parts: ContentPart[]): string {
  expect(parts).toHaveLength(3);
  expect(parts[1]).toMatchObject({ type: 'image_url' });
  return (parts[1] as { imageUrl: { url: string } }).imageUrl.url;
}

async function decodeResult(parts: ContentPart[]): Promise<{ image: Awaited<ReturnType<typeof Jimp.fromBuffer>>; mimeType: string; bytes: Buffer }> {
  const url = imageDataUrl(parts);
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(url);
  expect(match).not.toBeNull();
  const bytes = Buffer.from(match![2]!, 'base64');
  return { image: await Jimp.fromBuffer(bytes), mimeType: match![1]!, bytes };
}

describe('ImageZoomTool', () => {
  it('has name, parameters, schema validation, and a path-scoped read access', () => {
    const tool = makeTool({});
    expect(tool.name).toBe('ImageZoom');
    expect(tool.description).toContain('Crop, zoom, and annotate');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { image: { type: 'string' } },
    });

    expect(ImageZoomInputSchema.safeParse({ image: '/workspace/a.png' }).success).toBe(true);
    expect(
      ImageZoomInputSchema.safeParse({
        image: 'kimi-file://abc123',
        region: { x: 0, y: 0, width: 10, height: 10 },
        zoom: 2,
        annotations: [
          { type: 'arrow', from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, color: 'red', label: 'here' },
          { type: 'box', x: 1, y: 2, width: 3, height: 4 },
          { type: 'dot', x: 5, y: 6, radius: 2, color: '#00ff00' },
          { type: 'label', x: 0, y: 0, text: 'note' },
        ],
      }).success,
    ).toBe(true);
    expect(
      ImageZoomInputSchema.safeParse({ image: '/a.png', annotations: [{ type: 'label', x: 0, y: 0 }] }).success,
    ).toBe(false);
    expect(ImageZoomInputSchema.safeParse({ image: '/a.png', zoom: -1 }).success).toBe(false);
    expect(ImageZoomInputSchema.safeParse({ image: '/a.png', zoom: 0 }).success).toBe(false);
    expect(
      ImageZoomInputSchema.safeParse({ image: '/a.png', region: { x: -1, y: 0, width: 5, height: 5 } }).success,
    ).toBe(false);

    const execution = tool.resolveExecution({ image: '/workspace/a.png' }) as Extract<
      ToolExecution,
      { execute: unknown }
    >;
    expect(execution.accesses).toEqual(ToolAccesses.readFile('/workspace/a.png'));
    expect(execution.approvalRule).toBe('ImageZoom(/workspace/a.png)');
  });

  it('rejects an empty image reference', async () => {
    const result = await execute(makeTool({}), { image: '' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('cannot be empty');
  });

  it('crops a region and wraps the result in the read-media output shape', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 50, y: 40, width: 50, height: 40 },
    });

    const parts = outputParts(result);
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/workspace/q.png">' });
    expect(parts[2]).toEqual({ type: 'text', text: '</image>' });

    const { image, mimeType } = await decodeResult(parts);
    expect(mimeType).toBe('image/png');
    expect(image.width).toBe(50);
    expect(image.height).toBe(40);
    expect(image.getPixelColor(0, 0)).toBe(BLUE);
    expect(image.getPixelColor(49, 39)).toBe(BLUE);

    const note = noteText(result);
    expect(note).toMatch(/^<system>.*<\/system>$/s);
    expect(note).toContain('Mime type: image/png');
    expect(note).toContain('Original dimensions: 100x80 pixels');
    expect(note).toContain('Showing region (x=50, y=40, width=50, height=40)');
    expect(note).toContain('zoomed by a factor of 1 to 50x40 pixels');
    expect(note).toContain('(u, v)');
  });

  it('clamps an overhanging region to the image bounds', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 50, y: 40, width: 500, height: 500 },
    });
    const { image } = await decodeResult(outputParts(result));
    expect(image.width).toBe(50);
    expect(image.height).toBe(40);
    expect(noteText(result)).toContain('width=50, height=40');
  });

  it('applies the zoom factor after cropping', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 0, y: 0, width: 50, height: 40 },
      zoom: 2,
    });
    const { image } = await decodeResult(outputParts(result));
    expect(image.width).toBe(100);
    expect(image.height).toBe(80);
    expect(image.getPixelColor(0, 0)).toBe(RED);
    expect(image.getPixelColor(99, 79)).toBe(RED);
    expect(noteText(result)).toContain('zoomed by a factor of 2 to 100x80 pixels');
  });

  it('caps the zoomed result at 2000 pixels on the longest edge', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      zoom: 100,
    });
    const { image } = await decodeResult(outputParts(result));
    expect(image.width).toBe(2000);
    expect(image.height).toBe(1600);
    expect(noteText(result)).toContain('zoomed by a factor of 20');
  }, 20000);

  it('auto-fits large images within model limits when zoom is omitted', async () => {
    const big = await solidPng(2100, 1050);
    const result = await execute(makeTool({ '/workspace/big.png': { data: big } }), {
      image: '/workspace/big.png',
    });
    const { image } = await decodeResult(outputParts(result));
    expect(image.width).toBe(2000);
    expect(image.height).toBe(1000);
    const note = noteText(result);
    expect(note).toContain('Showing the full image');
    expect(note).toContain('zoomed by a factor of 0.952');
  }, 15000);

  it('draws a stroked box with the requested color', async () => {
    const png = await quadrantPng();
    const tool = makeTool({ '/workspace/q.png': { data: png } });
    const args: ImageZoomInput = {
      image: '/workspace/q.png',
      region: { x: 0, y: 0, width: 50, height: 40 },
    };
    const baseline = imageDataUrl(outputParts(await execute(tool, args)));
    const annotated = await execute(tool, {
      ...args,
      annotations: [{ type: 'box', x: 5, y: 5, width: 20, height: 10, color: '#00ff00' }],
    });

    expect(noteText(annotated)).toContain('1 annotation(s) drawn');
    const parts = outputParts(annotated);
    expect(imageDataUrl(parts)).not.toBe(baseline);
    const { image } = await decodeResult(parts);
    expect(image.getPixelColor(5, 5)).toBe(GREEN);
    expect(image.getPixelColor(24, 5)).toBe(GREEN);
    expect(image.getPixelColor(15, 10)).toBe(RED);
  });

  it('draws a dot with the default palette color when color is omitted', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 0, y: 0, width: 50, height: 40 },
      annotations: [{ type: 'dot', x: 25, y: 20, radius: 5 }],
    });
    const { image } = await decodeResult(outputParts(result));
    expect(image.getPixelColor(25, 20)).toBe(0x00e5ffff);
    expect(image.getPixelColor(0, 0)).toBe(RED);
  });

  it('draws an arrow with a shaft and a head', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 0, y: 0, width: 50, height: 40 },
      annotations: [{ type: 'arrow', from: { x: 5, y: 5 }, to: { x: 40, y: 30 }, color: 'blue' }],
    });
    const { image } = await decodeResult(outputParts(result));
    let bluePixels = 0;
    image.scan((x, y, idx) => {
      if (
        image.bitmap.data[idx] === 0 &&
        image.bitmap.data[idx + 1] === 0 &&
        image.bitmap.data[idx + 2] === 255
      ) {
        bluePixels++;
      }
    });
    expect(bluePixels).toBeGreaterThan(60);
    expect(image.getPixelColor(40, 30)).toBe(BLUE);
  });

  it('draws a label as light text on a dark band', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 0, y: 0, width: 50, height: 40 },
      annotations: [{ type: 'label', x: 2, y: 2, text: 'HI' }],
    });
    const { image } = await decodeResult(outputParts(result));
    expect(image.getPixelColor(2, 2)).toBe(0x000000ff);
    let lightPixels = 0;
    let darkPixels = 0;
    for (let y = 2; y < 20; y++) {
      for (let x = 2; x < 40; x++) {
        const color = image.getPixelColor(x, y);
        const r = (color >>> 24) & 0xff;
        const g = (color >>> 16) & 0xff;
        const b = (color >>> 8) & 0xff;
        if (r > 150 && g > 150 && b > 150) lightPixels++;
        if (color === 0x000000ff) darkPixels++;
      }
    }
    expect(lightPixels).toBeGreaterThan(0);
    expect(darkPixels).toBeGreaterThan(0);
  });

  it('scales annotation coordinates by the applied zoom factor', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 0, y: 0, width: 50, height: 40 },
      zoom: 2,
      annotations: [{ type: 'dot', x: 10, y: 10, radius: 3, color: '#00ff00' }],
    });
    const { image } = await decodeResult(outputParts(result));
    expect(image.getPixelColor(20, 20)).toBe(GREEN);
    expect(image.getPixelColor(10, 10)).toBe(RED);
    expect(noteText(result)).toContain('scaled by the applied zoom');
  });

  it('resolves kimi-file references through the session media store', async () => {
    const png = await quadrantPng();
    const store = fakeMediaStore({ file123: { data: png, name: 'pic.png' } });
    const tool = makeTool({}, capabilities(), store);

    const result = await execute(tool, {
      image: 'kimi-file://file123',
      region: { x: 50, y: 40, width: 50, height: 40 },
    });
    const parts = outputParts(result);
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/session/media/pic.png">' });
    const { image } = await decodeResult(parts);
    expect(image.width).toBe(50);
    expect(image.getPixelColor(0, 0)).toBe(BLUE);

    const missing = await execute(tool, { image: 'kimi-file://gone' });
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('not available in this session');
  });

  it('rejects kimi-file references when no session media store is wired', async () => {
    const result = await execute(makeTool({}), { image: 'kimi-file://file123' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('session file reference');
  });

  it('falls back to the JPEG ladder when the PNG busts the byte budget', async () => {
    setConfiguredReadImageByteBudget(32 * 1024);
    const noise = await noisePng(1200, 900);
    const result = await execute(makeTool({ '/workspace/noise.png': { data: noise } }), {
      image: '/workspace/noise.png',
    });
    const { mimeType, bytes } = await decodeResult(outputParts(result));
    expect(mimeType).toBe('image/jpeg');
    expect(bytes.length).toBeLessThanOrEqual(32 * 1024);
  }, 30000);

  it('returns an actionable error when even the ladder cannot meet the byte budget', async () => {
    setConfiguredReadImageByteBudget(1024);
    const noise = await noisePng(1200, 900);
    const result = await execute(makeTool({ '/workspace/noise.png': { data: noise } }), {
      image: '/workspace/noise.png',
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('per-image limit');
    expect(result.output).toContain('Reduce the zoom factor or choose a smaller region');
  }, 30000);

  it('reports a missing file as a read failure', async () => {
    const result = await execute(makeTool({}), { image: '/workspace/missing.png' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Failed to read /workspace/missing.png');
    expect(result.output).toContain('ENOENT');
  });

  it('rejects a region outside the image with the source dimensions in the error', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      region: { x: 500, y: 0, width: 10, height: 10 },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('100x80');
    expect(result.output).toContain('Cannot zoom');
  });

  it('rejects undecodable bytes with a decode error', async () => {
    const result = await execute(makeTool({ '/workspace/broken.png': { data: pngHeader() } }), {
      image: '/workspace/broken.png',
    });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/decode/i);
  });

  it('rejects an unknown annotation color with guidance', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      annotations: [{ type: 'dot', x: 1, y: 1, color: 'blorp' }],
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('blorp');
    expect(result.output).toContain('#ff8800');
  });

  it('rejects a non-positive zoom factor', async () => {
    const png = await quadrantPng();
    const result = await execute(makeTool({ '/workspace/q.png': { data: png } }), {
      image: '/workspace/q.png',
      zoom: -2,
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('positive finite');
  });

  it('redirects text files to the Read tool', async () => {
    const result = await execute(
      makeTool({ '/workspace/note.txt': { data: Buffer.from('hello world') } }),
      { image: '/workspace/note.txt' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Use Read');
  });

  it('errors without image input capability', async () => {
    const png = await quadrantPng();
    const result = await execute(
      makeTool({ '/workspace/q.png': { data: png } }, capabilities({ image_in: false })),
      { image: '/workspace/q.png' },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not support image input');
  });
});

describe('registerMediaTools ImageZoom registration', () => {
  const fs = createTestFs({});
  const env = createTestEnv();

  it('registers ImageZoom alongside ReadMediaFile when the model supports image input', () => {
    const registry = new AgentToolRegistryService();
    const disposable = registerMediaTools(registry, {
      runtime: runtimeFor(fs, env),
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: true, video_in: false }),
    });
    expect(registry.resolve('ImageZoom')).toBeInstanceOf(ImageZoomTool);
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
    disposable.dispose();
    expect(registry.resolve('ImageZoom')).toBeUndefined();
    expect(registry.resolve('ReadMediaFile')).toBeUndefined();
  });

  it('registers only ReadMediaFile when the model supports video but not image input', () => {
    const registry = new AgentToolRegistryService();
    registerMediaTools(registry, {
      runtime: runtimeFor(fs, env),
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: false, video_in: true }),
    });
    expect(registry.resolve('ImageZoom')).toBeUndefined();
    expect(registry.resolve('ReadMediaFile')).toBeInstanceOf(ReadMediaFileTool);
  });

  it('does not register ImageZoom when the runtime lacks filesystem availability', () => {
    const registry = new AgentToolRegistryService();
    const availableRuntime = runtimeFor(fs, env);
    registerMediaTools(registry, {
      runtime: { ...availableRuntime, isAvailable: () => false },
      workspace: WORKSPACE,
      capabilities: capabilities({ image_in: true, video_in: true }),
    });
    expect(registry.resolve('ImageZoom')).toBeUndefined();
  });
});

describe('AgentMediaToolsRegistrar ImageZoom wiring', () => {
  function createRegistrarHarness(mediaStore?: ISessionMediaStore) {
    const registry = new AgentToolRegistryService();
    const eventBus = new EventBusService();
    const agentContext = stubAgentContext('main', 1);
    eventBus.activateAgent(agentContext);
    const state = {
      alias: '',
      capabilities: capabilities({ image_in: false, video_in: false }),
    };
    const profile = {
      getModelCapabilities: () => state.capabilities,
      getModel: () => state.alias,
    } as unknown as IAgentProfileService;
    const modelCatalog = {
      getRequester: (id: string) => ({
        model: { id, name: id, providerName: 'test', protocol: 'openai' },
      }),
    } as unknown as IModelCatalog;
    const workspaceCtx = {
      workDir: '/workspace',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext;
    const baseRuntime = runtimeFor(createTestFs({}));
    const runtimeChanges = new Emitter<void>();
    const runtime: IAgentRuntimeService = {
      _serviceBrand: undefined,
      onDidChange: runtimeChanges.event,
      isAvailable: (required = []) => baseRuntime.isAvailable(required),
      inspect: () => baseRuntime.inspect(),
      acquire: (required = []) => baseRuntime.acquire(required),
    };
    const registrar = new AgentMediaToolsRegistrar(
      registry,
      profile,
      modelCatalog,
      eventBus,
      runtime,
      workspaceCtx,
      recordingNoopTelemetry(),
      new AgentStateService(),
      undefined,
      mediaStore,
    );
    const bindModel = (alias: string, caps: ModelCapability): void => {
      state.alias = alias;
      state.capabilities = caps;
      eventBus.publish(
        new AgentStatusUpdated({
          agentId: 'main',
          model: alias,
          maxContextTokens: caps.max_context_tokens,
        }),
        agentContext,
      );
    };
    return { registry, registrar, bindModel };
  }

  function recordingNoopTelemetry(): ITelemetryService {
    const telemetry: ITelemetryService = {
      _serviceBrand: undefined,
      track: () => {},
      track2: () => {},
      withContext: () => telemetry,
      setContext: () => {},
      addAppender: () => ({ dispose: () => {} }),
      removeAppender: () => {},
      setAppender: () => {},
      setEnabled: () => {},
      flush: async () => {},
      shutdown: async () => {},
    };
    return telemetry;
  }

  it('registers ImageZoom when an image-capable model binds and drops it for a text model', () => {
    const { registry, bindModel } = createRegistrarHarness();
    expect(registry.resolve('ImageZoom')).toBeUndefined();

    bindModel('vision-model', capabilities({ image_in: true, video_in: false }));
    expect(registry.resolve('ImageZoom')).toBeInstanceOf(ImageZoomTool);

    bindModel('text-model', capabilities({ image_in: false, video_in: false }));
    expect(registry.resolve('ImageZoom')).toBeUndefined();
  });

  it('passes the session media store through to the registered ImageZoom tool', async () => {
    const png = await quadrantPng();
    const store = fakeMediaStore({ file9: { data: png, name: 'shot.png' } });
    const { registry, bindModel } = createRegistrarHarness(store);
    bindModel('vision-model', capabilities({ image_in: true, video_in: false }));

    const tool = registry.resolve('ImageZoom');
    expect(tool).toBeInstanceOf(ImageZoomTool);
    const result = await execute(tool as ImageZoomTool, { image: 'kimi-file://file9' });
    const parts = outputParts(result);
    expect(parts[0]).toEqual({ type: 'text', text: '<image path="/session/media/shot.png">' });
  });
});
