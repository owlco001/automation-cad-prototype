#!/usr/bin/env node
/**
 * 把 CI 产出的 Qt 运行时目录搬进 desktop/vendor/qt/，供 electron-builder 以 extraResources
 * 打进 resources/qt/（asar 之外——DLL 必须能被 Qt 进程按「自身目录优先」加载到）。
 *
 * 源：环境变量 QT_DIST，默认 desktop/../qt-dist（仓库根下的 qt-dist，即 ci.yml
 * qt-windows-occt 里 dist/automationcad-qt-occt 的东西：automationcad-qt.exe 在根，DLL 同目录）。
 *
 * 校验三条，任一不过 exit 1：exe 在、文件数 ≥ 40、总字节 > 30 MB。
 * 宁可让打包构建红，也不出一个「点了没反应」的没有 Qt 的安装包。
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const source = resolve(process.env.QT_DIST ?? join(desktopRoot, '..', 'qt-dist'));
// VENDOR_QT_TARGET 只给测试用：让用例把产物搬到临时目录，别动仓库里的 vendor/qt。
const target = resolve(process.env.VENDOR_QT_TARGET ?? join(desktopRoot, 'vendor', 'qt'));
const EXE_NAME = 'automationcad-qt.exe';
const MIN_FILES = 40;
const MIN_BYTES = 30 * 1024 * 1024;

/** 递归数文件与字节（Qt+OCCT 的 dist 是平铺的，仍按递归算，避免子目录结构变动时漏算） */
async function measure(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      bytes += (await stat(path)).size;
    }
  }
  return { files, bytes };
}

function fail(reasons) {
  console.error(`VENDOR_QT_FAIL 源目录 ${source}`);
  for (const reason of reasons) console.error(`  - ${reason}`);
  console.error(`需要 ${EXE_NAME} + windeployqt 的整份运行时；先跑 ci.yml 的 qt-windows-occt，再把产物解到 QT_DIST。`);
  process.exit(1);
}

if (!existsSync(source)) {
  fail([`目录不存在（可用 QT_DIST 指定）`]);
}

const problems = [];
if (!existsSync(join(source, EXE_NAME))) problems.push(`缺可执行文件 ${EXE_NAME}`);
const before = await measure(source);
if (before.files < MIN_FILES) problems.push(`文件数 ${before.files} < ${MIN_FILES}（windeployqt 大概没跑）`);
if (before.bytes <= MIN_BYTES) {
  problems.push(`总字节 ${before.bytes} ≤ ${MIN_BYTES}（${(before.bytes / 1024 / 1024).toFixed(1)} MB，Qt+OCCT 正常约 60 MB）`);
}
if (problems.length > 0) fail(problems);

/** 只搬运行时需要的东西；以下都是 CI 打包过程的副产物，进安装包就是白占体积：
 *  - `automationcad-qt-windows-x64-occt.zip`（ci.yml 用 Compress-Archive 上传的那个 zip，
 *    解压后仍留在目录里，实测 61 MB —— 首个双端安装包 238.7 MB 里有四分之一是它）
 *  - `vc_redist.x64.exe`（windeployqt 放的运行库安装器，18 MB；我们已经把 CRT DLL 直接带进包，
 *    客户机不需要再装）
 *  - `version.out.txt` / `version.err.txt` / `clip.log` / `clip.err.log`（启动自检的日志）
 */
function shouldShip(relPath) {
  const name = relPath.split(/[\\/]/).pop().toLowerCase();
  if (name === EXE_NAME) return true;
  if (!name.endsWith('.dll')) return false;
  return true;
}

async function copyFiltered(from, to) {
  await mkdir(to, { recursive: true });
  let copied = 0;
  const skipped = [];
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      const child = await copyFiltered(src, dst);
      copied += child.copied;
      skipped.push(...child.skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!shouldShip(entry.name)) {
      skipped.push({ name: entry.name, bytes: (await stat(src)).size });
      continue;
    }
    await cp(src, dst);
    copied += 1;
  }
  return { copied, skipped };
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const copyResult = await copyFiltered(source, target);

// 拷完再核一次：cp 失败/被截断时不能报成功
if (!existsSync(join(target, EXE_NAME))) {
  console.error(`VENDOR_QT_FAIL 拷贝后 ${join(target, EXE_NAME)} 不存在`);
  process.exit(1);
}
const after = await measure(target);
if (after.files !== copyResult.copied) {
  console.error(`VENDOR_QT_FAIL 拷贝不完整：应拷 ${copyResult.copied} 个文件，目标 ${after.files} 个`);
  process.exit(1);
}
const skippedBytes = copyResult.skipped.reduce((sum, item) => sum + item.bytes, 0);
for (const item of copyResult.skipped) {
  console.log(`VENDOR_QT_SKIP ${item.name} ${(item.bytes / 1024 / 1024).toFixed(1)}MB`);
}

console.log(`VENDOR_QT_OK files=${after.files} bytes=${after.bytes} skipped=${copyResult.skipped.length} skippedBytes=${skippedBytes}`);
