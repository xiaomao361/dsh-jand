// DeepSeek Harness compatibility is only verified against one release. The
// version is read best-effort from the hosting context; when it cannot be read,
// the settings page still states the tested baseline instead of guessing.
export const TESTED_HARNESS = '0.2.1-rc.5';

export function detectHarness(ctx) {
  const readers = [
    () => ctx?.app?.version,
    () => ctx?.get?.('app')?.version,
    () => ctx?.get?.('version'),
    () => process.env.DSH_VERSION,
    () => process.env.DSH_HARNESS_VERSION,
  ];
  for (const read of readers) {
    try {
      const value = read();
      if (typeof value === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(value.trim())) return value.trim();
    } catch { /* a missing service is expected, not an error */ }
  }
  return null;
}

export function harnessState(version) {
  if (!version) return 'unknown';
  return version === TESTED_HARNESS ? 'tested' : 'untested';
}

export const harnessInfo = ctx => {
  const version = detectHarness(ctx);
  return { version, tested: TESTED_HARNESS, state: harnessState(version) };
};
