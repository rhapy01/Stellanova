declare module 'omggif' {
  export class GifReader {
    constructor(buffer: Uint8Array)
    width: number
    height: number
    numFrames(): number
    frameInfo(frame: number): { x: number; y: number; width: number; height: number; disposal?: number }
    decodeAndBlitFrameRGBA(frame: number, pixels: Uint8Array): void
  }
  export class GifWriter {
    constructor(buffer: Uint8Array, width: number, height: number, options?: { palette?: number[]; loop?: number })
    addFrame(x: number, y: number, width: number, height: number, indexedPixels: Uint8Array, options?: { delay?: number; disposal?: number; transparent?: number }): void
    end(): number
  }
}
