import { cropBox } from './derive';
import type { CropRequest, CropResult, Cropper } from './derive';
import type { PdfDocument } from './obsidian-internal';

/**
 * Crops source regions from the original PDF. All crops on a page share one raster;
 * every canvas is released (width/height = 0) even when rendering or encoding fails.
 * `createCanvas` is Obsidian's `() => createEl('canvas')` in the plugin, a mock in tests.
 */
export function createCanvasCropper(pdf: Pick<PdfDocument, 'getPage'>, createCanvas: () => HTMLCanvasElement, scale: number): Cropper {
  return {
    async cropPage(pageNumber: number, requests: CropRequest[]): Promise<Map<string, CropResult>> {
      const results = new Map<string, CropResult>();
      const page = await pdf.getPage(pageNumber);
      const unit = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale });
      const full = createCanvas();
      full.width = Math.ceil(viewport.width);
      full.height = Math.ceil(viewport.height);
      try {
        const context = full.getContext('2d');
        if (!context) throw new Error('无法创建画布。');
        await page.render({ canvas: full, canvasContext: context, viewport, intent: 'print' }).promise;
        for (const request of requests) {
          const [x0, y0, x1, y1] = cropBox(request, unit.width, unit.height);
          const crop = createCanvas();
          crop.width = Math.max(1, Math.ceil((x1 - x0) * full.width));
          crop.height = Math.max(1, Math.ceil((y1 - y0) * full.height));
          try {
            const cropContext = crop.getContext('2d');
            if (!cropContext) throw new Error('无法创建画布。');
            cropContext.drawImage(full, x0 * full.width, y0 * full.height, crop.width, crop.height, 0, 0, crop.width, crop.height);
            // Captions stay selectable text in the reader, so they are blanked out of the image.
            cropContext.fillStyle = '#fff';
            for (const [cx0, cy0, cx1, cy1] of request.masks) {
              cropContext.fillRect((cx0 - x0) * full.width - 1, (cy0 - y0) * full.height - 1, (cx1 - cx0) * full.width + 2, (cy1 - cy0) * full.height + 2);
            }
            results.set(request.blockId, { png: await encodePng(crop), width: crop.width, height: crop.height });
          } finally {
            crop.width = 0; crop.height = 0;
          }
        }
      } finally {
        full.width = 0; full.height = 0;
        page.cleanup();
      }
      return results;
    },
  };
}

async function encodePng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
    if (value) resolve(value); else reject(new Error('原文图表生成失败。'));
  }, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
