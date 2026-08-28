import type { ModelCapability } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import {
  inspectAgentRuntime,
  type IAgentRuntimeService,
} from '#/agent/runtimeBinding/agentRuntime';
import {
  ToolAccesses,
  type AgentTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { resolvePathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import { MEDIA_SNIFF_BYTES, detectFileType } from '#/agent/media/file-type';
import {
  MAX_IMAGE_DECODE_BYTES,
  formatByteSize,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  zoomImageForModel,
  type ImageCompressionTelemetry,
  type ZoomImageSuccess,
} from '#/agent/media/image-compress';
import {
  buildImageConversionGuidance,
  isModelAcceptedImageMime,
} from '#/agent/media/image-format-policy';
import { parseDaemonFileUrl } from '#/agent/media/mediaRef';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_MEGABYTES,
} from '#/agent/tools/read-media-file/read-media-file';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { ImageZoomInputSchema, type ImageZoomInput } from './image-zoom';
import imageZoomDescription from './image-zoom.md?raw';

function buildDecodeLimitError(size: number): string {
  return (
    `Image is too large to process safely for zooming (${String(size)} bytes; ` +
    `safe decode limit ${String(MAX_IMAGE_DECODE_BYTES)} bytes). ` +
    'The image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy, ' +
    'then call ImageZoom on the resulting file.'
  );
}

function formatZoomFactor(zoom: number): string {
  return String(Math.round(zoom * 1000) / 1000);
}

function buildZoomNote(input: {
  readonly mimeType: string;
  readonly byteSize: number;
  readonly outcome: ZoomImageSuccess;
}): string {
  const { outcome } = input;
  const { region } = outcome;
  const parts: string[] = [
    'Processed image with ImageZoom.',
    `Mime type: ${input.mimeType}.`,
    `Size: ${String(input.byteSize)} bytes.`,
    `Original dimensions: ${String(outcome.originalWidth)}x${String(outcome.originalHeight)} pixels.`,
  ];
  const isFullImage =
    region.x === 0 &&
    region.y === 0 &&
    region.width === outcome.originalWidth &&
    region.height === outcome.originalHeight;
  const subject = isFullImage
    ? 'Showing the full image'
    : `Showing region (x=${String(region.x)}, y=${String(region.y)}, ` +
      `width=${String(region.width)}, height=${String(region.height)}) of the original image`;
  parts.push(
    `${subject}, zoomed by a factor of ${formatZoomFactor(outcome.zoom)} to ` +
      `${String(outcome.width)}x${String(outcome.height)} pixels ` +
      `(${outcome.mimeType}, ${formatByteSize(outcome.finalByteLength)})` +
      (outcome.annotationCount === 0
        ? '.'
        : ` with ${String(outcome.annotationCount)} annotation(s) drawn.`),
  );
  if (outcome.annotationCount > 0) {
    parts.push(
      'Annotation coordinates were interpreted relative to the shown region before zoom ' +
        'and scaled by the applied zoom.',
    );
  }
  parts.push(
    'To output coordinates in original-image pixels for a point (u, v) in the delivered image, ' +
      `compute (x=${String(region.x)} + u * ${String(region.width)}/${String(outcome.width)}, ` +
      `y=${String(region.y)} + v * ${String(region.height)}/${String(outcome.height)}).`,
  );
  parts.push(
    'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.',
  );
  return `<system>${parts.join(' ')}</system>`;
}

export class ImageZoomTool implements AgentTool<ImageZoomInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ImageZoom' as const;
  readonly description: string = imageZoomDescription.trim();
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ImageZoomInputSchema);
  private readonly zoomTelemetry: ImageCompressionTelemetry | undefined;
  constructor(
    private readonly runtime: IAgentRuntimeService,
    private readonly workspace: WorkspaceConfig,
    private readonly capabilities: ModelCapability,
    private readonly mediaStore?: ISessionMediaStore,
    telemetry?: ITelemetryService,
  ) {
    this.zoomTelemetry =
      telemetry === undefined ? undefined : { client: telemetry, source: 'image_zoom' };
  }

  resolveExecution(args: ImageZoomInput): ToolExecution {
    if (!args.image) {
      return { isError: true, output: 'Image path cannot be empty.' };
    }
    const ref = parseDaemonFileUrl(args.image);
    if (ref !== undefined) {
      return this.resolveDaemonExecution(args, ref.fileId);
    }
    const inspected = inspectAgentRuntime(this.runtime);
    const env = inspected.environment;
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspace.workspaceDir,
      additionalDirs: this.workspace.additionalDirs,
    });
    const workspace = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
    const path = resolvePathAccessPath(args.image, {
      env,
      workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Zooming image: ${args.image}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: env.pathClass,
          homeDir: env.homeDir,
        }),
      execute: async () => {
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          return await this.execution(args, path, lease.runtime.fs!, env);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private resolveDaemonExecution(args: ImageZoomInput, fileId: string): ToolExecution {
    const env = inspectAgentRuntime(this.runtime).environment;
    return {
      accesses: ToolAccesses.none(),
      description: `Zooming image: ${args.image}`,
      approvalRule: literalRulePattern(this.name, args.image),
      execute: async () => {
        const store = this.mediaStore;
        if (store === undefined) {
          return {
            isError: true,
            output:
              `"${args.image}" is a session file reference, but session files are not available here. ` +
              'Save the image to a file and pass its path instead.',
          };
        }
        try {
          const stored = await store.read(fileId);
          if (stored === undefined) {
            return {
              isError: true,
              output:
                `"${args.image}" is not available in this session. It may have expired or been ` +
                'removed; ask the user to re-attach the image or provide a file path.',
            };
          }
          const displayPath = (await store.resolveDisplayPath(fileId)) ?? args.image;
          return await this.process(
            args,
            Buffer.from(stored.data),
            stored.name,
            displayPath,
            env,
          );
        } catch (error) {
          return {
            isError: true,
            output: `Failed to process ${args.image}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  }

  private async execution(
    args: ImageZoomInput,
    safePath: string,
    fs: IHostFileSystem,
    env: HostEnvironmentInfo,
  ): Promise<ExecutableToolResult> {
    try {
      const header = await fs.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header, 'media');

      if (fileType.kind === 'text') {
        return {
          isError: true,
          output: `"${args.image}" is a text file. Use Read to read text files.`,
        };
      }
      if (fileType.kind === 'video') {
        return {
          isError: true,
          output: `"${args.image}" is a video file. ImageZoom supports image files only; use ReadMediaFile for videos.`,
        };
      }

      const stat = await fs.stat(safePath);
      if (stat.size === 0) {
        return { isError: true, output: `"${args.image}" is empty.` };
      }
      if (stat.size > MAX_MEDIA_BYTES) {
        return {
          isError: true,
          output:
            `"${args.image}" is ${String(stat.size)} bytes, which exceeds the ` +
            `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
        };
      }
      if (stat.size > MAX_IMAGE_DECODE_BYTES) {
        return { isError: true, output: buildDecodeLimitError(stat.size) };
      }

      const data = Buffer.from(await fs.readBytes(safePath));
      return await this.process(args, data, safePath, safePath, env);
    } catch (error) {
      return {
        isError: true,
        output: `Failed to read ${args.image}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async process(
    args: ImageZoomInput,
    data: Buffer,
    sourceName: string,
    displayPath: string,
    env: HostEnvironmentInfo,
  ): Promise<ExecutableToolResult> {
    const fileType = detectFileType(sourceName, data.subarray(0, MEDIA_SNIFF_BYTES), 'media');
    if (fileType.kind === 'text') {
      return {
        isError: true,
        output: `"${args.image}" is a text file. Use Read to read text files.`,
      };
    }
    if (fileType.kind !== 'image') {
      return {
        isError: true,
        output:
          `"${args.image}" is not a supported image file. ` +
          'ImageZoom supports PNG, JPEG, and WebP images.',
      };
    }
    if (!this.capabilities.image_in) {
      return {
        isError: true,
        output:
          'The current model does not support image input. ' +
          'Tell the user to use a model with image input capability.',
      };
    }
    if (!isModelAcceptedImageMime(fileType.mimeType)) {
      return {
        isError: true,
        output: buildImageConversionGuidance(args.image, fileType.mimeType, env.osKind),
      };
    }
    if (data.length === 0) {
      return { isError: true, output: `"${args.image}" is empty.` };
    }
    if (data.length > MAX_IMAGE_DECODE_BYTES) {
      return { isError: true, output: buildDecodeLimitError(data.length) };
    }

    const outcome = await zoomImageForModel(data, fileType.mimeType, {
      region: args.region,
      zoom: args.zoom,
      annotations: args.annotations,
      byteBudget: resolveReadImageByteBudget(),
      maxEdge: resolveMaxImageEdgePx(),
      telemetry: this.zoomTelemetry,
    });
    if (!outcome.ok) {
      return { isError: true, output: `Cannot zoom "${args.image}": ${outcome.error}` };
    }

    const base64 = Buffer.from(outcome.data).toString('base64');
    const output: ContentPart[] = [
      { type: 'text', text: `<image path="${displayPath}">` },
      {
        type: 'image_url',
        imageUrl: { url: `data:${outcome.mimeType};base64,${base64}` },
      },
      { type: 'text', text: '</image>' },
    ];

    const note = buildZoomNote({
      mimeType: fileType.mimeType,
      byteSize: data.length,
      outcome,
    });

    return { output, note, isError: false };
  }
}
