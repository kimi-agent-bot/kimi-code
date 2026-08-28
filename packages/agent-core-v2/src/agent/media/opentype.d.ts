declare module 'opentype.js' {
  export interface OpenTypePathCommand {
    readonly type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    readonly x?: number;
    readonly y?: number;
    readonly x1?: number;
    readonly y1?: number;
    readonly x2?: number;
    readonly y2?: number;
  }

  export interface OpenTypePath {
    readonly commands: readonly OpenTypePathCommand[];
  }

  export interface OpenTypeFont {
    readonly ascender: number;
    readonly descender: number;
    readonly unitsPerEm: number;
    getPath(text: string, x: number, y: number, fontSize: number): OpenTypePath;
    getAdvanceWidth(text: string, fontSize: number): number;
  }

  export function parse(buffer: ArrayBuffer): OpenTypeFont;

  const opentype: { readonly parse: typeof parse };
  export default opentype;
}
