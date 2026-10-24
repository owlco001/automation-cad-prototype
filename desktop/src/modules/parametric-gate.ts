export const PARAMETRIC_IMPORT_MODULE_ID = 'cad.parametric-import';

export const PARAMETRIC_MODULE_DISABLED_MESSAGE =
  '功能模块「cad.parametric-import」当前已关闭；参数化特征编辑与重建已停用，但 STEP/IGES/CAD 只读查看和原始导入几何仍可使用，已保存特征树与叠加体会保留。未识别的 STEP 特征不会自动变成可编辑特征；重新启用后可继续操作。';

export interface ParametricModuleDisabledBuildResult {
  ok: false;
  code: 'MODULE_DISABLED';
  message: string;
}

export function isParametricImportEnabled(read: (() => boolean) | undefined): boolean {
  if (!read) return true;
  try {
    return read() === true;
  } catch {
    return false;
  }
}

export function parametricModuleDisabledBuildResult(): ParametricModuleDisabledBuildResult {
  return {
    ok: false,
    code: 'MODULE_DISABLED',
    message: PARAMETRIC_MODULE_DISABLED_MESSAGE
  };
}

export function parametricModuleDisabledStatus(): { status: 'unavailable'; message: string } {
  return { status: 'unavailable', message: PARAMETRIC_MODULE_DISABLED_MESSAGE };
}
