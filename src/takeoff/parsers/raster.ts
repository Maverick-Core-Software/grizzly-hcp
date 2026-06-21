import { readFile } from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

export type SupportedRasterFormat = 'png' | 'jpg' | 'jpeg' | 'tiff' | 'tif';

const SUPPORTED_FORMATS: SupportedRasterFormat[] = ['png', 'jpg', 'jpeg', 'tiff', 'tif'];

export async function parseRaster(imagePath: string): Promise<{
  image: Buffer;
  format: SupportedRasterFormat;
  widthPx: number;
  heightPx: number;
}> {
  const ext = path.extname(imagePath).toLowerCase().replace('.', '') as SupportedRasterFormat;

  if (!SUPPORTED_FORMATS.includes(ext)) {
    throw new Error(
      `Unsupported raster format: "${ext}". Supported: ${SUPPORTED_FORMATS.join(', ')}`,
    );
  }

  const inputBuffer = await readFile(imagePath);

  if (ext === 'tif' || ext === 'tiff') {
    // Convert TIFF → PNG via sharp; get dimensions from the result
    const pngBuffer = await sharp(inputBuffer).png().toBuffer();
    const meta = await sharp(pngBuffer).metadata();
    return {
      image: pngBuffer,
      format: ext,
      widthPx: meta.width ?? 0,
      heightPx: meta.height ?? 0,
    };
  }

  // PNG / JPG — read directly, get dimensions via sharp metadata
  const meta = await sharp(inputBuffer).metadata();
  return {
    image: inputBuffer,
    format: ext,
    widthPx: meta.width ?? 0,
    heightPx: meta.height ?? 0,
  };
}
