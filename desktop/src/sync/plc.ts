import type { MachineConfig } from '../commission/machine-config.ts';
import { buildMachineIoMap } from '../machine/io-map.ts';
import { generateProject } from '../plcgen/generate.ts';
import { PLCGEN_VERSION } from '../plcgen/st.ts';
import { requireModuleEnabled } from '../modules/tool-gates.ts';
import type { SyncPlcUploadPayload } from './types.ts';

/** 先校验两个模块状态，再执行 PLC 生成；关闭时不进入生成器或映射构建。 */
export function buildSyncPlcPayload(
  config: MachineConfig,
  plcgenEnabled: boolean,
  plcSyncEnabled: boolean
): SyncPlcUploadPayload {
  requireModuleEnabled('plcgen', plcgenEnabled);
  requireModuleEnabled('factory.plc-sync', plcSyncEnabled);
  const target = 'generic' as const;
  const project = generateProject({ config, target });
  if (!project.ok) {
    const detail = project.errors.map((issue) => issue.message).join('；');
    throw new Error(`PLC 预检失败，未创建或上传同步包：${detail || '请检查机型配置'}`);
  }
  const ioMap = buildMachineIoMap(config);
  return {
    target,
    generatedVersion: PLCGEN_VERSION,
    machineId: config.id,
    programFiles: project.files
      .filter((file) => file.path !== 'README.md')
      .map((file) => ({ path: file.path, content: file.content })),
    mappingCsv: ioMap.csv
  };
}

/** 非 PLC 同步模式返回 undefined，调用者无需机型上下文且不会生成源码或 IO mapping。 */
export function buildOptionalSyncPlcPayload(
  config: MachineConfig | null,
  plcgenEnabled: boolean,
  plcSyncEnabled: boolean
): SyncPlcUploadPayload | undefined {
  if (!plcSyncEnabled) return undefined;
  requireModuleEnabled('plcgen', plcgenEnabled);
  if (!config) throw new Error('当前没有机型 IO 上下文，不能生成 PLC 同步内容');
  return buildSyncPlcPayload(config, plcgenEnabled, plcSyncEnabled);
}
