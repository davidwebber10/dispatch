import { describe, it, expect } from 'vitest';
import { compareVersions, getImageVersion, getReportedVersion, getRunningVersion, isNewerVersion } from './version.js';

describe('getRunningVersion', () => {
  it('reads the version from packages/core/package.json', () => {
    expect(getRunningVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('isNewerVersion', () => {
  it('is true when the candidate has a higher patch/minor/major', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
  });

  it('is false when equal or older', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('tolerates a leading "v" on either side', () => {
    expect(isNewerVersion('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('v1.0.0', 'v1.0.0')).toBe(false);
  });
});

describe('box builds (docs/hosted.md, "Box releases")', () => {
  const base = getRunningVersion();

  it('orders a box build after its release and before the next release', () => {
    expect(isNewerVersion('4.14.1-box.1', '4.14.1')).toBe(true);
    expect(isNewerVersion('4.14.1-box.2', '4.14.1-box.1')).toBe(true);
    expect(isNewerVersion('4.14.1-box.10', '4.14.1-box.9')).toBe(true);
    expect(isNewerVersion('4.14.2', '4.14.1-box.9')).toBe(true);
    expect(isNewerVersion('4.14.1', '4.14.1-box.1')).toBe(false);
    expect(isNewerVersion('4.14.1-box.1', '4.14.1-box.1')).toBe(false);
    expect(isNewerVersion('4.14.1-box.9', '4.14.2')).toBe(false);
    expect(compareVersions('v4.14.1-box.1', '4.14.1-box.1')).toBe(0);
    expect(['4.14.2', '4.14.1-box.2', '4.14.1', '4.14.1-box.1'].sort(compareVersions))
      .toEqual(['4.14.1', '4.14.1-box.1', '4.14.1-box.2', '4.14.2']);
  });

  it('reports the image version only when it is a box build of the running release', () => {
    expect(getReportedVersion({})).toBe(base);
    expect(getReportedVersion({ DISPATCH_IMAGE_VERSION: '' })).toBe(base);
    expect(getReportedVersion({ DISPATCH_IMAGE_VERSION: `${base}-box.3` })).toBe(`${base}-box.3`);
    expect(getReportedVersion({ DISPATCH_IMAGE_VERSION: base })).toBe(base);
    expect(getImageVersion({ DISPATCH_IMAGE_VERSION: '0.0.0-ci.abcdef123456' })).toBeNull();
    expect(getImageVersion({ DISPATCH_IMAGE_VERSION: '1.0.0-box.1' })).toBeNull();
    expect(getImageVersion({ DISPATCH_IMAGE_VERSION: `${base}-box.0` })).toBeNull();
    expect(getImageVersion({ DISPATCH_IMAGE_VERSION: `box-${base}-1` })).toBeNull();
  });

  it('a box version never has the desktop release tag shape', () => {
    expect(/^v\d+\.\d+\.\d+$/.test(`v${base}-box.1`)).toBe(false);
    expect(/^v\d+\.\d+\.\d+$/.test(`box-${base}-1`)).toBe(false);
  });
});
