// Electron 主进程侧的「几何联动 / PLC 体检」桥。
//
// 纪律与 Qt 一致：**运动学和 PLC 判断全部由 desktop 的纯函数算**，主进程只负责把结果取回来，
// 渲染进程只负责显示。这里用 CLI 子进程（`--linkage --motion-check` / `--plc-audit`）而不是
// 重新 import 一遍，避免「界面算出来的数字」和「CLI/文档里的数字」漂移。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MachineBridgeOptions {
  /** desktop 根目录（app.getAppPath()） */
  appRoot: string;
  brief: string;
  /** 额外 CLI 参数，例如 ['--linkage','--motion-check','--linkage-frames','120'] */
  args: string[];
  timeoutMs?: number;
}

const scriptPath = (appRoot: string): string => join(appRoot, 'scripts', 'machine-design-cli.mjs');

/** 跑一次整机管线，返回解析后的完整 JSON（失败抛错，错误里带 exit code 与 stderr） */
export function runMachineCli(options: MachineBridgeOptions): Promise<any> {
  const script = scriptPath(options.appRoot);
  if (!existsSync(script)) {
    return Promise.reject(new Error(`找不到整机管线脚本：${script}`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--brief', options.brief, '--with-geometry', ...options.args], {
      cwd: options.appRoot,
      // Electron 主进程里 process.execPath 是 electron 本体，必须走 ELECTRON_RUN_AS_NODE 才能当 node 用
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('整机管线超时（180 s）'));
    }, options.timeoutMs ?? 180_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`整机管线失败（exit ${code}）：${stderr.trim().slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('整机管线输出不是 JSON'));
      }
    });
  });
}

/** 几何联动：时间线 + 预生成帧 + 运动包络 */
export async function loadMachineLinkage(appRoot: string, brief: string, frames = 120): Promise<any> {
  const document = await runMachineCli({
    appRoot,
    brief,
    args: ['--linkage', '--motion-check', '--linkage-frames', String(frames)]
  });
  const linkage = document.linkage;
  if (!linkage) throw new Error('管线没有返回 linkage（需 --linkage）');
  return linkage;
}

/** PLC 体检：缺口 / 补齐 / 步序 / 程序↔3D 对账 */
export async function loadPlcAudit(appRoot: string, brief: string): Promise<any> {
  const document = await runMachineCli({ appRoot, brief, args: ['--plc-audit'] });
  const audit = document.plcAudit;
  if (!audit) throw new Error('管线没有返回 plcAudit（需 --plc-audit）');
  return audit;
}
