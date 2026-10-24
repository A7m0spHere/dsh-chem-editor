// Keep chemical diagnostics separate from canvas history and annotation state.
export async function checkCandidate(indigo: any, candidate: any, original?: any) {
  const types = ['valence', 'query', 'pseudoatoms', 'radicals', ...(original ? ['stereo'] : [])];
  const checks = await indigo.check(candidate, { types });
  const originalChecks = original ? await indigo.check(original, { types: ['stereo'] }) : {};
  const existingStereo = checks.stereo && checks.stereo === originalChecks.stereo ? checks.stereo : '';
  if (existingStereo) delete checks.stereo;
  if (Object.values(checks).some(value => typeof value === 'string' && value.trim())) {
    throw new Error(`结构检查未通过：${JSON.stringify(checks)}`);
  }
  return { existingStereo };
}
