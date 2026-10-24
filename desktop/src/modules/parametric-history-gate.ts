export const PARAMETRIC_HISTORY_MODULE_ID = 'parametric.history';

export const PARAMETRIC_HISTORY_DISABLED_MESSAGE =
  '功能模块「parametric.history」当前已关闭；撤销/重做控件与程序化入口已停用，当前特征树、模型和会话历史保持不变。继续编辑仍会记录历史；重新启用后可在本会话接续使用。';

export function isParametricHistoryEnabled(read: (() => boolean) | undefined): boolean {
  if (!read) return true;
  try {
    return read() === true;
  } catch {
    return false;
  }
}
