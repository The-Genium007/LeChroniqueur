import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { cropToVertical, getImageDimensions } from '../../src/derivation/media-processor.js';

beforeAll(() => {
  process.env['DRY_RUN'] = 'true';
  try { loadConfig(); } catch { /* already loaded */ }
  try { createLogger(); } catch { /* already created */ }
});

async function createTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  }).png().toBuffer();
}

describe('cropToVertical', () => {
  it('should crop a 1:1 image to approximately 9:16', async () => {
    const squareImage = await createTestImage(1024, 1024);
    const cropped = await cropToVertical(squareImage);

    const dims = await getImageDimensions(cropped);

    // 9:16 ratio from 1024 height → width should be ~576 (1024 * 9/16)
    expect(dims.width).toBe(Math.floor(1024 * 9 / 16));
    expect(dims.height).toBe(1024);

    // Verify the ratio is close to 9:16
    const ratio = dims.width / dims.height;
    expect(ratio).toBeCloseTo(9 / 16, 1);
  });

  it('should produce a buffer smaller than the original', async () => {
    const squareImage = await createTestImage(512, 512);
    const cropped = await cropToVertical(squareImage);

    // Cropped image has fewer pixels → smaller buffer
    expect(cropped.length).toBeLessThan(squareImage.length);
  });

  it('should throw for empty buffer', async () => {
    await expect(cropToVertical(Buffer.alloc(0))).rejects.toThrow();
  });
});

describe('getImageDimensions', () => {
  it('should return correct dimensions for a square image', async () => {
    const image = await createTestImage(256, 256);
    const dims = await getImageDimensions(image);

    expect(dims.width).toBe(256);
    expect(dims.height).toBe(256);
  });

  it('should return correct dimensions for a rectangular image', async () => {
    const image = await createTestImage(1920, 1080);
    const dims = await getImageDimensions(image);

    expect(dims.width).toBe(1920);
    expect(dims.height).toBe(1080);
  });
});
