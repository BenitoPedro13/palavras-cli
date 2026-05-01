declare module "pngjs" {
  import type { Buffer } from "node:buffer";

  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    constructor(options?: { width?: number; height?: number; fill?: boolean });

    static sync: {
      read(buffer: Buffer): PNG;
      write(png: PNG): Buffer;
    };

    static bitblt(
      src: PNG,
      dst: PNG,
      srcX: number,
      srcY: number,
      width: number,
      height: number,
      dstX: number,
      dstY: number
    ): void;
  }
}
