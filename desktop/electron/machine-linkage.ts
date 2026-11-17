// Electron 主进程侧的「几何联动 / PLC 体检」桥。
// 运动学和 PLC 判断由 CLI 计算；主进程只启动管线并取回 JSON。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipelineCandidates, resolvePipelinePath, type SpawnLike } from './qt-client.ts';

export const MACHINE_STDOUT_LIMIT = 64 * 1024 * 1024;
export const MACHINE_STDERR_LIMIT = 64 * 1024;

export interface MachineRuntimeOptions {
  isPackaged?: boolean;
  resourcesPath?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** 默认 process.execPath；Electron 通过 ELECTRON_RUN_AS_NODE 运行 CLI。 */
  electronExePath?: string;
  /** 单测注入点；默认 node 的 spawn。 */
  spawnImpl?: SpawnLike;
}

export interface MachineBridgeOptions extends MachineRuntimeOptions {
  /** desktop 根目录（app.getAppPath()） */
  appRoot: string;
  brief: string;
  /** 额外 CLI 参数，例如 ['--linkage','--motion-check','--linkage-frames','120'] */
  args: string[];
}

/** 跑一次整机管线；所有异步失败都等 close 后才返回，避免遗留子进程。 */
export function runMachineCli(options: MachineBridgeOptions): Promise<any> {
  const paths = {
    appRoot: options.appRoot,
    ...(options.resourcesPath === undefined ? {} : { resourcesPath: options.resourcesPath }),
    isPackaged: options.isPackaged ?? false
  };
  const source = join(options.appRoot, 'scripts', 'machine-design-cli.mjs');
  const script = resolvePipelinePath(paths) ?? (!paths.isPackaged && existsSync(source) ? source : null);
  if (!script) {
    const candidates = pipelineCandidates(paths).map((candidate) => candidate.path);
    if (!paths.isPackaged) candidates.push(source);
    return Promise.reject(new Error(`找不到整机管线脚本：${candidates.join(' / ') || '缺少 resourcesPath'}`));
  }
  const timeoutMs = options.timeoutMs ?? 180_000;
  const stdoutLimit = options.maxStdoutBytes ?? MACHINE_STDOUT_LIMIT;
  const stderrLimit = options.maxStderrBytes ?? MACHINE_STDERR_LIMIT;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(stdoutLimit) || stdoutLimit <= 0 ||
      !Number.isSafeInteger(stderrLimit) || stderrLimit <= 0) {
    return Promise.reject(new Error('整机管线 timeoutMs 和输出字节上限必须是有效正整数'));
  }
  return new Promise((resolve, reject) => {
    const child = (options.spawnImpl ?? spawn)(options.electronExePath ?? process.execPath,
      [script, '--brief', options.brief, '--with-geometry', ...options.args], {
        // appRoot 在安装包里可能是 app.asar，不能作为真实子进程的 cwd。
        cwd: paths.isPackaged ? dirname(script) : options.appRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const fail = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      clearTimeout(timer);
      // spawn 失败时没有 pid；Node 仍会发送 close。已退出的进程也只需等管道关闭。
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* 保留最初的失败，仍等待 close。 */ }
      }
    };
    const timer = setTimeout(() => fail(new Error(`整机管线超时（${timeoutMs} ms）`)), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (failure || settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > stdoutLimit - stdoutBytes) {
        fail(new Error(`整机管线 stdout 超过上限（${stdoutLimit} bytes）`));
        return;
      }
      stdoutBytes += bytes.length;
      stdout.push(Buffer.from(bytes));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (failure || settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > stderrLimit - stderrBytes) {
        fail(new Error(`整机管线 stderr 超过上限（${stderrLimit} bytes）`));
        return;
      }
      stderrBytes += bytes.length;
      stderr.push(Buffer.from(bytes));
    });
    child.stdout?.on('error', fail);
    child.stderr?.on('error', fail);
    child.on('error', fail);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) {
        reject(new Error(`整机管线失败（exit ${code}${signal ? `, signal ${signal}` : ''}）：${Buffer.concat(stderr).toString('utf8').trim().slice(0, 300)}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        reject(new Error('整机管线输出不是 JSON'));
      }
    });
  });
}

/** 几何联动：时间线 + 预生成帧 + 运动包络。旧的三个位置参数保持兼容。 */
export async function loadMachineLinkage(appRoot: string, brief: string, frames = 120, options: MachineRuntimeOptions = {}): Promise<any> {
  const document = await runMachineCli({
    ...options,
    appRoot,
    brief,
    args: ['--linkage', '--motion-check', '--linkage-frames', String(frames)]
  });
  const linkage = document.linkage;
  if (!linkage) throw new Error('管线没有返回 linkage（需 --linkage）');
  return linkage;
}

/** PLC 体检：缺口 / 补齐 / 步序 / 程序↔3D 对账。 */
export async function loadPlcAudit(appRoot: string, brief: string, options: MachineRuntimeOptions = {}): Promise<any> {
  const document = await runMachineCli({ ...options, appRoot, brief, args: ['--plc-audit'] });
  const audit = document.plcAudit;
  if (!audit) throw new Error('管线没有返回 plcAudit（需 --plc-audit）');
  return audit;
}
