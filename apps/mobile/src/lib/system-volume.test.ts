import { describe, expect, it } from 'vitest';
import { validateSystemVolumeInput } from './system-volume';

describe('validateSystemVolumeInput', () => {
  it('accepts in-range volumes', () => {
    expect(validateSystemVolumeInput('380')).toEqual({ ok: true, value: 380 });
    expect(validateSystemVolumeInput('10')).toEqual({ ok: true, value: 10 });
    expect(validateSystemVolumeInput('5000')).toEqual({ ok: true, value: 5000 });
    expect(validateSystemVolumeInput(' 250.5 ')).toEqual({
      ok: true,
      value: 250.5,
    });
  });

  it('rejects out-of-bounds volumes', () => {
    expect(validateSystemVolumeInput('9')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Minimum'),
    });
    expect(validateSystemVolumeInput('5001')).toMatchObject({
      ok: false,
      error: expect.stringContaining('Maximum'),
    });
  });

  it('rejects non-numeric and empty input', () => {
    for (const raw of ['', '   ', 'abc', '38o', '-']) {
      expect(validateSystemVolumeInput(raw)).toMatchObject({ ok: false });
    }
  });
});
