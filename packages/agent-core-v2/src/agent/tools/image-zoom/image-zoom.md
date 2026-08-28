Crop, zoom, and annotate an image, then view the processed result.

**Tips:**
- Make sure you follow the description of each tool parameter.
- The `image` parameter is a file path (resolved like ReadMediaFile paths) or a "kimi-file://<fileId>" reference to an image attached to this session.
- A `<system>` tag accompanies the processed image; it summarizes the mime type, byte size, source dimensions, applied region, applied zoom, final dimensions, and annotation count, and explains how to map delivered-image coordinates back to original-image pixels.
- Use `region` (original-image pixel coordinates) to crop before zooming; omit it to process the whole image. A region outside the image returns an error that reports the source dimensions.
- `zoom` is applied after the crop: values above 1 zoom in (upscale), below 1 zoom out. The longest edge of the result is capped at 2000 pixels. Omit `zoom` to auto-fit the image within model limits.
- `annotations` are baked into the delivered image as pixels: arrows, boxes, dots, and text labels. Their coordinates are relative to the cropped region before zoom, or to the full image when no region is given.
- Use annotations to mark features you want to reference precisely; labels render as light text on a dark band so they stay readable over any content.
- Colors accept common named colors (for example "red", "cyan", "orange") or hex strings like "#ff8800"; omitted colors cycle through a high-contrast palette.
- Only PNG, JPEG, and WebP images are supported. Convert other formats first.
