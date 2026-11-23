#!/usr/bin/env node
/**
 * 安装包体积与 asar 分块完整性报告（CI 可复现的「体积证据」）。
 *
 * 用法：
 *   node scripts/report-package-size.mjs [--dir release] [--json release/package-size-report.json]
 *
 * 输出两部分：
 *   1. 人读摘要（stdout）：每个 .exe 的字节/sha256、app.asar 字节、resources/** 与
 *      win-unpacked/** 合计字节、asar 内分块完整性结论；
 *   2. 机器可读 JSON（--json 指定的文件；不指定则只打印人读摘要）。
 *
 * 退出码：
 *   0 报告已生成（asar 完整性为 verified，或因 @electron/asar 不可用而 notVerified）；
 *   2 产物缺失（--dir 不存在 / 没有 .exe / 没有 resources/app.asar / 没有 win-unpacked）；
 *   3 asar 存在、但清单或分块抽不出来、或字节/sha256 与清单不一致。
 *
 * 重要口径：
 *   - `resources/**` 包含 `win-unpacked/resources/**`，所以它和 `win-unpacked/**` 是重叠的两个合计，
 *     不是互斥分项；两个数字都报，避免读者把其中一个当成「包外资源」。
 *   - asar 完整性只证明「包内的分块与 manifest 逐字节一致」，**不证明安装包体积会因分块而下降**。
 *     分块仍随 `files: dist/**` 打进 asar，见 docs/desktop/MODULE-CHUNKS-SIZE.md §3。
 *   - 不联网、不修改产物；`--json` 只写报告文件。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 1;

const USAGE = `用法: node scripts/report-package-size.mjs [选项]

选项:
  --dir <目录>    要扫描的产物目录（默认 desktop/release）
  --json <文件>   把机器可读 JSON 写到该文件（UTF-8）
  --help, -h      显示本帮助

退出码: 0 报告成功；2 产物缺失；3 asar 分块完整性失败。`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { dir: join(desktopRoot, 'release'), json: null, help: false };
  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new UsageError(`${flag} 缺少路径参数`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir' || arg === '--json') {
      options[arg.slice(2)] = readValue(index, arg);
      index += 1;
    } else if (arg.startsWith('--dir=')) {
      options.dir = arg.slice('--dir='.length);
    } else if (arg.startsWith('--json=')) {
      options.json = arg.slice('--json='.length);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new UsageError(`未知参数：${arg}`);
    }
  }
  if (options.dir === '') throw new UsageError('--dir 不能为空');
  if (options.json === '') throw new UsageError('--json 不能为空');
  return {
    dir: resolve(process.cwd(), options.dir),
    json: options.json ? resolve(process.cwd(), options.json) : null,
    help: options.help
  };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function writeJsonFile(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function displayPath(root, path) {
  return toPosix(relative(root, path));
}

/**
 * 递归列出普通文件；不跟随符号链接（避免 release 里出现链接时死循环或重复计数）。
 * 返回的字节数来自 stat，而不是 Dirent（Dirent 不带大小）。
 */
function walkFiles(root) {
  const files = [];
  const symlinksSkipped = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        let stats;
        try {
          stats = statSync(fullPath);
        } catch (error) {
          throw new Error(`无法读取文件 ${fullPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
        files.push({ path: fullPath, bytes: stats.size });
      } else if (entry.isSymbolicLink()) {
        symlinksSkipped.push(fullPath);
      }
    }
  }
  return { files, symlinksSkipped };
}

function sumInDirectory(files, directory) {
  const prefix = directory.endsWith(sep) ? directory : directory + sep;
  let bytes = 0;
  let count = 0;
  for (const file of files) {
    if (file.path.startsWith(prefix)) {
      bytes += file.bytes;
      count += 1;
    }
  }
  return { bytes, files: count };
}

function findResourcesDirectories(reportDir, immediateChildren) {
  const candidates = [];
  const roots = [reportDir, ...immediateChildren];
  for (const root of roots) {
    const resources = join(root, 'resources');
    if (isDirectory(resources) && !candidates.includes(resources)) candidates.push(resources);
  }
  return candidates;
}

function findUnpackedDirectory(reportDir, immediateChildren) {
  const windows = join(reportDir, 'win-unpacked');
  if (isDirectory(windows)) return windows;
  return immediateChildren.find((dir) => /-unpacked$/i.test(dir.split(sep).pop() ?? '')) ?? null;
}

function findAppAsar(files, unpackedDir) {
  const preferred = unpackedDir ? join(unpackedDir, 'resources', 'app.asar') : null;
  if (preferred && existsSync(preferred)) {
    return preferred;
  }
  const candidates = files
    .map((file) => file.path)
    .filter((path) => path.split(sep).pop() === 'app.asar' && path.split(sep).at(-2) === 'resources')
    .sort((left, right) => left.localeCompare(right));
  return candidates[0] ?? null;
}

/**
 * 从 asar 抽 manifest + 每个分块，逐字节核对 bytes/sha256。
 * 返回结构固定包含 {status, checked, ok, failures, reason, manifest}；抽不到时为 notVerified
 * 或 failed，绝不把「没抽到」写成 ok。
 */
function inspectAsarChunks(asarPath) {
  const result = {
    status: 'notVerified',
    checked: 0,
    ok: 0,
    failures: [],
    reason: null,
    manifest: null
  };

  let asar;
  try {
    asar = require('@electron/asar');
  } catch (error) {
    result.reason = `@electron/asar 不可用（未安装或无法 require）：${error instanceof Error ? error.message : String(error)}`;
    return result;
  }
  if (typeof asar.extractFile !== 'function') {
    result.reason = '@electron/asar 已加载但没有 extractFile API';
    return result;
  }

  let manifestBytes;
  try {
    manifestBytes = Buffer.from(asar.extractFile(asarPath, 'dist/modules/manifest.json'));
  } catch (error) {
    result.status = 'failed';
    result.reason = 'dist/modules/manifest.json 无法从 asar 抽取';
    result.failures.push({
      file: 'dist/modules/manifest.json',
      reason: 'manifest-not-extractable',
      message: error instanceof Error ? error.message : String(error)
    });
    return result;
  }

  const manifestSha = sha256(manifestBytes);
  result.manifest = {
    path: 'dist/modules/manifest.json',
    bytes: manifestBytes.length,
    sha256: manifestSha,
    chunksDeclared: null,
    disk: null
  };

  // 若本机正好有构建时的 dist/modules/manifest.json，顺便记录 asar 里的清单与它是否同一份。
  // 这能提示「打包用了旧 dist」；它只作信息字段，CI 在 workflow 里另设硬门槛。
  // 没有磁盘清单时明确记 notAvailable，不假装核对过。
  const diskManifestPath = join(desktopRoot, 'dist', 'modules', 'manifest.json');
  if (existsSync(diskManifestPath)) {
    try {
      const diskBytes = readFileSync(diskManifestPath);
      const diskSha = sha256(diskBytes);
      const match = diskBytes.equals(manifestBytes);
      result.manifest.disk = {
        path: toPosix(relative(desktopRoot, diskManifestPath)),
        bytes: diskBytes.length,
        sha256: diskSha,
        match
      };
    } catch (error) {
      result.manifest.disk = {
        path: toPosix(relative(desktopRoot, diskManifestPath)),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  } else {
    result.manifest.disk = { path: toPosix(relative(desktopRoot, diskManifestPath)), match: null, reason: 'not-available' };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    result.status = 'failed';
    result.reason = 'asar 内 manifest.json 不是合法 JSON';
    result.failures.push({
      file: 'dist/modules/manifest.json',
      reason: 'manifest-invalid-json',
      message: error instanceof Error ? error.message : String(error)
    });
    return result;
  }

  const chunks = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
  result.manifest.chunksDeclared = chunks.length;
  if (chunks.length === 0) {
    result.status = 'failed';
    result.reason = 'asar 内 manifest.json 没有 chunks[]';
    result.failures.push({
      file: 'dist/modules/manifest.json',
      reason: 'manifest-has-no-chunks'
    });
    return result;
  }

  for (const entry of chunks) {
    const id = typeof entry?.id === 'string' ? entry.id : '(missing-id)';
    const fileName = typeof entry?.file === 'string' ? entry.file.replaceAll('\\', '/') : '';
    result.checked += 1;
    if (!fileName || fileName.startsWith('/') || fileName.split('/').includes('..')) {
      result.failures.push({
        id,
        file: fileName || '(missing-file)',
        reason: 'manifest-entry-invalid'
      });
      continue;
    }
    const asarFile = `dist/modules/${fileName}`;
    const expectedBytes = Number(entry?.bytes);
    const expectedSha = typeof entry?.sha256 === 'string' ? entry.sha256.toLowerCase() : '';
    if (!Number.isFinite(expectedBytes) || expectedBytes < 0 || !/^[0-9a-f]{64}$/.test(expectedSha)) {
      result.failures.push({
        id,
        file: asarFile,
        reason: 'manifest-entry-invalid',
        expectedBytes: entry?.bytes ?? null,
        expectedSha256: entry?.sha256 ?? null
      });
      continue;
    }

    let chunkBytes;
    try {
      chunkBytes = Buffer.from(asar.extractFile(asarPath, asarFile));
    } catch (error) {
      result.failures.push({
        id,
        file: asarFile,
        reason: 'not-found-or-unreadable',
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    const actualBytes = chunkBytes.length;
    const actualSha = sha256(chunkBytes);
    if (actualBytes === expectedBytes && actualSha === expectedSha) {
      result.ok += 1;
    } else {
      result.failures.push({
        id,
        file: asarFile,
        reason: 'content-mismatch',
        expectedBytes,
        actualBytes,
        expectedSha256: expectedSha,
        actualSha256: actualSha
      });
    }
  }

  result.status = result.failures.length === 0 ? 'verified' : 'failed';
  return result;
}

function formatBytes(bytes) {
  return Number(bytes).toLocaleString('en-US');
}

function printHumanReport(report) {
  const lines = [];
  lines.push(`PACKAGE_SIZE_REPORT dir=${report.dir}`);
  lines.push(`status=${report.status}`);
  if (report.missing.length > 0) {
    lines.push(`missing=${report.missing.join(' | ')}`);
  }
  lines.push('');
  lines.push(`EXE (${report.exe.length})`);
  for (const item of report.exe) {
    lines.push(`  ${item.path}  ${formatBytes(item.bytes)} B  sha256=${item.sha256}  area=${item.area}`);
  }
  if (report.exe.length === 0) lines.push('  (none)');
  lines.push('');
  if (report.appAsar) {
    lines.push(`APP_ASAR ${report.appAsar.path}  ${formatBytes(report.appAsar.bytes)} B`);
  } else {
    lines.push('APP_ASAR (missing)');
  }
  if (report.resources) {
    lines.push(
      `RESOURCES  ${formatBytes(report.resources.bytes)} B in ${formatBytes(report.resources.files)} files  ` +
        `paths=${report.resources.paths.join(',') || '(none)'}`
    );
  } else {
    lines.push('RESOURCES (missing)');
  }
  if (report.winUnpacked) {
    lines.push(
      `WIN_UNPACKED  ${formatBytes(report.winUnpacked.bytes)} B in ${formatBytes(report.winUnpacked.files)} files  ` +
        `path=${report.winUnpacked.path}`
    );
  } else {
    lines.push('WIN_UNPACKED (missing)');
  }
  lines.push('');
  const chunk = report.asarChunkIntegrity;
  // notVerified 时人读摘要不出现 "ok" 字样（避免把「没验」读成「验过」）；JSON 里仍保留 ok 计数字段。
  const okLabel = chunk.status === 'notVerified' ? 'matched' : 'ok';
  lines.push(`ASAR_CHUNK_INTEGRITY status=${chunk.status} checked=${chunk.checked} ${okLabel}=${chunk.ok} failures=${chunk.failures.length}`);
  if (chunk.reason) lines.push(`  reason=${chunk.reason}`);
  for (const failure of chunk.failures) {
    lines.push(`  FAIL ${failure.file}${failure.id ? ` id=${failure.id}` : ''} reason=${failure.reason}`);
  }
  if (chunk.manifest?.disk) {
    lines.push(
      `  manifest sha256=${chunk.manifest.sha256} bytes=${formatBytes(chunk.manifest.bytes)} ` +
        `diskMatch=${String(chunk.manifest.disk.match)}`
    );
  }
  lines.push('');
  lines.push(
    'NOTE 分块仍在 asar 内（files: dist/**/*）；本报告只证明包内分块与清单一致，不证明安装包因分块变小。'
  );
  if (report.jsonPath) lines.push(`JSON ${report.jsonPath}`);
  console.log(lines.join('\n'));
}

function buildMissingReport(reportDir, missing, jsonPath) {
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tool: 'report-package-size',
    dir: reportDir,
    status: 'missing',
    missing,
    exe: [],
    appAsar: null,
    resources: null,
    winUnpacked: null,
    asarChunkIntegrity: {
      status: 'notVerified',
      checked: 0,
      ok: 0,
      failures: [],
      reason: '产物缺失，未执行 asar 抽取'
    },
    jsonPath
  };
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`PACKAGE_SIZE_ERROR ${error.message}`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const { dir: reportDir, json: jsonPath } = options;
  if (!isDirectory(reportDir)) {
    const missing = [`产物目录不存在或不是目录：${reportDir}`];
    const report = buildMissingReport(reportDir, missing, jsonPath);
    if (jsonPath) writeJsonFile(jsonPath, report);
    printHumanReport(report);
    console.error(`PACKAGE_SIZE_MISSING ${missing.join(' | ')}`);
    process.exitCode = 2;
    return;
  }

  const { files, symlinksSkipped } = walkFiles(reportDir);
  const immediateChildren = readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(reportDir, entry.name));
  const unpackedDir = findUnpackedDirectory(reportDir, immediateChildren);
  const resourcesDirs = findResourcesDirectories(reportDir, immediateChildren);
  const appAsarPath = findAppAsar(files, unpackedDir);

  const exeFiles = files
    .filter((file) => file.path.toLowerCase().endsWith('.exe'))
    .sort((left, right) => left.path.localeCompare(right.path));
  const exe = [];
  for (const file of exeFiles) {
    const relativePath = displayPath(reportDir, file.path);
    const inUnpacked = unpackedDir ? file.path.startsWith(unpackedDir + sep) : false;
    exe.push({
      path: relativePath,
      bytes: file.bytes,
      sha256: await sha256File(file.path),
      area: inUnpacked ? 'win-unpacked' : 'release-root'
    });
  }

  let resources = null;
  if (resourcesDirs.length > 0) {
    let bytes = 0;
    let count = 0;
    for (const directory of resourcesDirs) {
      const sum = sumInDirectory(files, directory);
      bytes += sum.bytes;
      count += sum.files;
    }
    resources = {
      bytes,
      files: count,
      paths: resourcesDirs.map((directory) => displayPath(reportDir, directory)).sort()
    };
  }

  let winUnpacked = null;
  if (unpackedDir) {
    const sum = sumInDirectory(files, unpackedDir);
    winUnpacked = {
      path: displayPath(reportDir, unpackedDir),
      bytes: sum.bytes,
      files: sum.files
    };
  }

  const appAsar = appAsarPath
    ? {
        path: displayPath(reportDir, appAsarPath),
        bytes: statSync(appAsarPath).size
      }
    : null;

  const missing = [];
  if (exe.length === 0) missing.push('产物目录下没有任何 .exe');
  if (!appAsar) missing.push('没有 resources/app.asar');
  if (!winUnpacked) missing.push('没有 win-unpacked/ 目录');

  const asarChunkIntegrity = appAsarPath
    ? inspectAsarChunks(appAsarPath)
    : {
        status: 'notVerified',
        checked: 0,
        ok: 0,
        failures: [],
        reason: '没有 app.asar，未执行 asar 抽取'
      };

  let status = 'ok';
  if (missing.length > 0) status = 'missing';
  else if (asarChunkIntegrity.status === 'failed') status = 'integrity-failed';
  else if (asarChunkIntegrity.status === 'notVerified') status = 'unverified';

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tool: 'report-package-size',
    dir: reportDir,
    status,
    missing,
    exe,
    appAsar,
    resources,
    winUnpacked,
    symlinksSkipped: symlinksSkipped.map((path) => displayPath(reportDir, path)).sort(),
    asarChunkIntegrity,
    jsonPath
  };

  if (jsonPath) writeJsonFile(jsonPath, report);
  printHumanReport(report);

  if (missing.length > 0) {
    console.error(`PACKAGE_SIZE_MISSING ${missing.join(' | ')}`);
    process.exitCode = 2;
  } else if (asarChunkIntegrity.status === 'failed') {
    console.error(
      `PACKAGE_SIZE_ASAR_FAILED checked=${asarChunkIntegrity.checked} ok=${asarChunkIntegrity.ok} ` +
        `failures=${asarChunkIntegrity.failures.length}`
    );
    process.exitCode = 3;
  } else if (asarChunkIntegrity.status === 'notVerified') {
    // 不当作失败：没有 @electron/asar 时仍可交付体积数字。但绝不打印 ok/verified。
    console.warn(`PACKAGE_SIZE_ASAR_NOT_VERIFIED ${asarChunkIntegrity.reason ?? '未知原因'}`);
  }
}

main().catch((error) => {
  console.error(`PACKAGE_SIZE_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 2;
});
