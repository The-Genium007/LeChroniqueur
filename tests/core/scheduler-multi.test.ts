import { describe, it, expect } from 'vitest';
import { applyCronOffset } from '../../src/core/scheduler-multi.js';

describe('applyCronOffset', () => {
  it('should offset minutes in a standard cron', () => {
    expect(applyCronOffset('0 7 * * *', 3)).toBe('3 7 * * *');
  });

  it('should wrap around 60 minutes', () => {
    expect(applyCronOffset('58 7 * * *', 5)).toBe('3 7 * * *');
  });

  it('should return unchanged when offset is 0', () => {
    expect(applyCronOffset('0 7 * * *', 0)).toBe('0 7 * * *');
  });

  it('should handle non-zero starting minute', () => {
    expect(applyCronOffset('15 8 * * *', 10)).toBe('25 8 * * *');
  });

  it('should handle weekly cron', () => {
    expect(applyCronOffset('0 21 * * 0', 6)).toBe('6 21 * * 0');
  });

  it('should return unchanged for non-numeric minute field', () => {
    expect(applyCronOffset('*/5 * * * *', 3)).toBe('*/5 * * * *');
  });

  it('should return unchanged for invalid cron format', () => {
    expect(applyCronOffset('invalid', 3)).toBe('invalid');
  });
});
