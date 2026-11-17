/** Pure format dispatch shared with the renderer; OCCT runtime stays worker-only. */
export function occtFormatForFile(name: string): 'step' | 'iges' | 'brep' | null {
  const ext = name.toLowerCase().split('.').pop() || '';
  if (ext === 'step' || ext === 'stp') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  if (ext === 'brep') return 'brep';
  return null;
}
