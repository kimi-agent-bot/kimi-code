import { z } from 'zod';

const annotationPointSchema = z.object({
  x: z.number().describe('Horizontal coordinate in pixels.'),
  y: z.number().describe('Vertical coordinate in pixels.'),
});

const annotationColorSchema = z
  .string()
  .optional()
  .describe(
    'Named color (for example "red", "cyan", "orange") or hex string like "#ff8800". ' +
      'Omitted colors cycle through a high-contrast palette.',
  );

export const ImageZoomAnnotationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('arrow'),
    from: annotationPointSchema.describe('Tail of the arrow.'),
    to: annotationPointSchema.describe('Tip of the arrow (where the arrowhead is drawn).'),
    color: annotationColorSchema,
    label: z.string().optional().describe('Short text drawn next to the arrow midpoint.'),
  }),
  z.object({
    type: z.literal('box'),
    x: z.number().describe('Left edge of the rectangle in pixels.'),
    y: z.number().describe('Top edge of the rectangle in pixels.'),
    width: z.number().describe('Rectangle width in pixels.'),
    height: z.number().describe('Rectangle height in pixels.'),
    color: annotationColorSchema,
    label: z.string().optional().describe('Short text drawn inside the top-left corner.'),
  }),
  z.object({
    type: z.literal('dot'),
    x: z.number().describe('Horizontal center of the dot in pixels.'),
    y: z.number().describe('Vertical center of the dot in pixels.'),
    radius: z.number().optional().describe('Dot radius in pixels; a size-aware default is used when omitted.'),
    color: annotationColorSchema,
    label: z.string().optional().describe('Short text drawn to the right of the dot.'),
  }),
  z.object({
    type: z.literal('label'),
    x: z.number().describe('Left edge of the label band in pixels.'),
    y: z.number().describe('Top edge of the label band in pixels.'),
    text: z.string().describe('Text to draw, rendered as light text on a dark band.'),
    color: annotationColorSchema.describe(
      'Named color (for example "red", "cyan", "orange") or hex string like "#ff8800" for the ' +
        'label band; the text stays light for contrast. Defaults to a black band.',
    ),
  }),
]);

export type ImageZoomAnnotationInput = z.infer<typeof ImageZoomAnnotationSchema>;

export const ImageZoomInputSchema = z.object({
  image: z
    .string()
    .describe(
      'Image to process: a file path (relative paths resolve against the working directory; ' +
        'a path outside the working directory must be absolute) or a "kimi-file://<fileId>" ' +
        'reference to an image attached to this session. PNG, JPEG, and WebP are supported.',
    ),
  region: z
    .object({
      x: z.number().int().min(0).describe('Left edge of the crop, in original-image pixels.'),
      y: z.number().int().min(0).describe('Top edge of the crop, in original-image pixels.'),
      width: z.number().int().min(1).describe('Crop width, in original-image pixels.'),
      height: z.number().int().min(1).describe('Crop height, in original-image pixels.'),
    })
    .optional()
    .describe(
      'Crop this rectangle first (original-image pixel coordinates), before zoom and ' +
        'annotations. Omit to process the whole image.',
    ),
  zoom: z
    .number()
    .positive()
    .optional()
    .describe(
      'Scale factor applied after the crop: values above 1 zoom in (upscale), below 1 zoom out. ' +
        'The longest edge of the result is capped at 2000 pixels. Omit to auto-fit the image ' +
        'within model limits.',
    ),
  annotations: z
    .array(ImageZoomAnnotationSchema)
    .max(50)
    .optional()
    .describe(
      'Annotations drawn onto the delivered image. Coordinates are relative to the cropped ' +
        'region before zoom, or to the full image when region is omitted.',
    ),
});

export type ImageZoomInput = z.infer<typeof ImageZoomInputSchema>;
