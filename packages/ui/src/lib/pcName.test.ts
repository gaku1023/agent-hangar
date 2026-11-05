import { describe, expect, it } from 'vitest';
import { pillName } from './pcName.ts';

describe('pillName', () => {
  it('末尾の .local を落とす', () => {
    expect(pillName('MacBook-Pro.local')).toBe('MacBook-Pro');
    expect(pillName('MacBook-Pro.LOCAL.')).toBe('MacBook-Pro');
  });
  it('ほかの名前はそのまま', () => {
    expect(pillName('DESKTOP-ABC123')).toBe('DESKTOP-ABC123');
    expect(pillName('local')).toBe('local');
    expect(pillName('a.local.example')).toBe('a.local.example');
  });
  it('.local だけなら落とさない', () => {
    expect(pillName('.local')).toBe('.local');
  });
});
