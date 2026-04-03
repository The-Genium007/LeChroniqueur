import sharp from 'sharp';
import { getLogger } from '../core/logger.js';

/**
 * Crops a 1:1 image to 9:16 by taking the center vertical strip.
 * Loses ~44% of the image (sides).
 */
export async function cropToVertical(buffer: Buffer): Promise<Buffer> {
  const logger = getLogger();
  const metadata = await sharp(buffer).metadata();

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width === 0 || height === 0) {
    throw new Error('Cannot crop: image has no dimensions');
  }

  // For 9:16 from a square, we need width = height * 9/16
  const targetWidth = Math.floor(height * 9 / 16);
  const left = Math.floor((width - targetWidth) / 2);

  logger.debug(
    { originalWidth: width, originalHeight: height, targetWidth, left },
    'Cropping 1:1 → 9:16',
  );

  return sharp(buffer)
    .extract({ left, top: 0, width: targetWidth, height })
    .toBuffer();
}

/**
 * Resizes an image to specific dimensions while maintaining aspect ratio.
 */
export async function resizeImage(
  buffer: Buffer,
  targetWidth: number,
  targetHeight: number,
): Promise<Buffer> {
  return sharp(buffer)
    .resize(targetWidth, targetHeight, { fit: 'cover' })
    .toBuffer();
}

/**
 * Gets image dimensions from a buffer.
 */
export async function getImageDimensions(buffer: Buffer): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer).metadata();
  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
  };
}
