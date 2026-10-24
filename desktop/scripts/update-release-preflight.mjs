import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyUpdateRelease(tagName, appVersion) {
  if (typeof tagName !== 'string' || !tagName.startsWith('v')) {
    throw new Error('发行 tag 必须采用 v<SemVer> 格式。');
  }
  const versionInTag = tagName.slice(1);
  if (versionInTag !== appVersion) {
    throw new Error(`发行 tag ${tagName} 与 desktop/package.json 版本 ${appVersion} 不一致。`);
  }
  if (/^\d+\.\d+\.\d+$/.test(versionInTag)) {
    return { channel: 'stable', publishChannel: 'latest', prerelease: false };
  }
  if (/^\d+\.\d+\.\d+-beta\.\d+$/.test(versionInTag)) {
    return { channel: 'beta', publishChannel: 'beta', prerelease: true };
  }
  throw new Error('只允许 stable vX.Y.Z 或 beta vX.Y.Z-beta.N 发行；不支持其他预发布通道。');
}

export function validateUpdateReleasePreflight({ tagName, appVersion, certificate, certificatePassword, buildConfig }) {
  const release = classifyUpdateRelease(tagName, appVersion);
  const publish = buildConfig?.publish;
  if (buildConfig?.win?.verifyUpdateCodeSignature !== true) {
    throw new Error('发行阻断：build.win.verifyUpdateCodeSignature 必须显式为 true。');
  }
  if (buildConfig?.win?.publish != null) {
    throw new Error('发行阻断：请将渠道发布配置放在 build.publish 根级，避免 beta channel 被覆盖。');
  }
  if (buildConfig?.nsis?.differentialPackage !== true) {
    throw new Error('发行阻断：build.nsis.differentialPackage 必须显式为 true。');
  }
  if (publish?.provider !== 'github' || publish?.owner !== 'owlco001' ||
      publish?.repo !== 'automation-cad-prototype' || publish?.channel !== 'latest') {
    throw new Error('发行阻断：build.publish 必须指向指定 GitHub 仓库且默认 latest channel。');
  }
  const missing = [];
  if (typeof certificate !== 'string' || !certificate.trim()) missing.push('CSC_LINK');
  if (typeof certificatePassword !== 'string' || !certificatePassword.trim()) missing.push('CSC_KEY_PASSWORD');
  if (missing.length) {
    throw new Error(`发行阻断：缺少 Authenticode 签名凭据 ${missing.join(', ')}；不得生成或发布生产更新。`);
  }
  return release;
}

function hasNonEmptyPublisherName(configText) {
  const match = configText.match(/^publisherName:[ \t]*(.*)$/m);
  if (!match) return false;
  const inline = (match[1] ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
  if (inline && inline !== '[]' && inline !== 'null' && inline !== '~') return true;
  for (const line of configText.slice((match.index ?? 0) + match[0].length).split(/\r?\n/)) {
    if (line && !/^\s/.test(line)) break;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (!item) continue;
    const value = (item[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
    if (value && value !== 'null' && value !== '~') return true;
  }
  return false;
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseUpdateFileRecords(metadata) {
  const records = [];
  let inFiles = false;
  let current = null;
  for (const line of metadata.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles && line && !/^\s/.test(line)) {
      inFiles = false;
      if (current) records.push(current);
      current = null;
    }
    if (!inFiles) continue;
    const urlMatch = line.match(/^\s*-\s+url:\s*(.*?)\s*$/);
    if (urlMatch) {
      if (current) records.push(current);
      current = { url: parseYamlScalar(urlMatch[1]) };
      continue;
    }
    if (!current) continue;
    const hashMatch = line.match(/^\s+sha512:\s*(.*?)\s*$/);
    if (hashMatch) current.sha512 = parseYamlScalar(hashMatch[1]);
    const sizeMatch = line.match(/^\s+size:\s*(.*?)\s*$/);
    if (sizeMatch) {
      const rawSize = parseYamlScalar(sizeMatch[1]);
      current.size = /^\d+$/.test(rawSize) ? Number(rawSize) : Number.NaN;
    }
  }
  if (current) records.push(current);
  return records;
}

function artifactNameFromUrl(url) {
  let name;
  try {
    name = decodeURIComponent(url);
  } catch {
    throw new Error(`更新清单含无效文件 URL：${url}`);
  }
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new Error(`更新清单文件 URL 必须是产物文件名：${url}`);
  }
  return name;
}

export function verifyUpdateReleaseArtifacts({ releaseDir, channel, expectedVersion }) {
  if (channel !== 'stable' && channel !== 'beta') throw new Error('更新渠道只能是 stable 或 beta。');
  if (!existsSync(releaseDir)) throw new Error(`缺少构建产物目录：${releaseDir}`);
  const names = readdirSync(releaseDir);
  const installers = names.filter((name) => /^AutomationCAD-Setup-.+\.exe$/i.test(name));
  if (!installers.length) throw new Error('缺少 NSIS 安装程序 .exe。');
  const metadataName = channel === 'beta' ? 'beta.yml' : 'latest.yml';
  const metadataPath = join(releaseDir, metadataName);
  if (!existsSync(metadataPath)) throw new Error(`缺少 ${metadataName} 更新清单。`);
  const metadata = readFileSync(metadataPath, 'utf8');
  const versionMatch = metadata.match(/^version:\s*(.*?)\s*$/m);
  const metadataVersion = versionMatch ? parseYamlScalar(versionMatch[1]) : '';
  if (!metadataVersion || !expectedVersion) {
    throw new Error(`${metadataName} 缺少版本信息或预期 package.json 版本。`);
  }
  if (metadataVersion !== expectedVersion) {
    throw new Error(`${metadataName} 版本 ${metadataVersion} 与 package.json 版本 ${expectedVersion} 不一致。`);
  }
  const records = parseUpdateFileRecords(metadata).filter((record) => /\.exe$/i.test(record.url ?? ''));
  if (!records.length) throw new Error(`${metadataName} 缺少 NSIS 安装器文件记录及 SHA-512。`);
  const filesByName = new Map(records.map((record) => [artifactNameFromUrl(record.url), record]));
  for (const installer of installers) {
    const record = filesByName.get(installer);
    if (!record) throw new Error(`${metadataName} 未引用实际安装器 ${installer}。`);
    const installerPath = join(releaseDir, installer);
    const actualSize = statSync(installerPath).size;
    if (!Number.isSafeInteger(record.size) || record.size !== actualSize) {
      throw new Error(`${metadataName} 中 ${installer} 的 size 与实际文件不一致。`);
    }
    const actualSha512 = createHash('sha512').update(readFileSync(installerPath)).digest('base64');
    if (record.sha512 !== actualSha512) {
      throw new Error(`${metadataName} 中 ${installer} 的 SHA-512 与实际文件不一致。`);
    }
    const blockmapPath = join(releaseDir, `${installer}.blockmap`);
    if (!existsSync(blockmapPath) || !statSync(blockmapPath).isFile() || statSync(blockmapPath).size === 0) {
      throw new Error(`缺少 ${installer}.blockmap；差分更新产物不完整。`);
    }
  }

  const embeddedConfigPath = join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml');
  if (!existsSync(embeddedConfigPath)) throw new Error('缺少安装包内 app-update.yml 更新源配置。');
  const embeddedConfig = readFileSync(embeddedConfigPath, 'utf8');
  if (!/^provider:\s*github\s*$/m.test(embeddedConfig) ||
      !/^owner:\s*owlco001\s*$/m.test(embeddedConfig) ||
      !/^repo:\s*automation-cad-prototype\s*$/m.test(embeddedConfig)) {
    throw new Error('安装包更新源不是预期的 HTTPS GitHub Releases 配置。');
  }
  if (!hasNonEmptyPublisherName(embeddedConfig)) {
    throw new Error('安装包 app-update.yml 没有有效 publisherName；为避免绕过 Authenticode 校验，阻止发布。');
  }
  return { installer: installers[0], metadata: metadataName, blockmap: true, publisherName: true, version: metadataVersion, sha512: true, size: true };
}

function writeGithubOutputs(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const packagePath = resolve(fileURLToPath(new URL('../package.json', import.meta.url)));
  const packageConfig = JSON.parse(readFileSync(packagePath, 'utf8'));
  const appVersion = packageConfig.version;
  if (args.includes('--preflight')) {
    const release = validateUpdateReleasePreflight({
      tagName: process.env.GITHUB_REF_NAME,
      appVersion,
      certificate: process.env.CSC_LINK,
      certificatePassword: process.env.CSC_KEY_PASSWORD,
      buildConfig: packageConfig.build
    });
    writeGithubOutputs({ channel: release.channel, publish_channel: release.publishChannel, prerelease: String(release.prerelease) });
    console.log(`UPDATE_RELEASE_PREFLIGHT_OK channel=${release.channel} version=${appVersion}`);
    return;
  }
  if (args.includes('--artifacts')) {
    const channelIndex = args.indexOf('--channel');
    const dirIndex = args.indexOf('--dir');
    const channel = channelIndex >= 0 ? args[channelIndex + 1] : undefined;
    const releaseDir = resolve(dirIndex >= 0 ? args[dirIndex + 1] || './release' : './release');
    const result = verifyUpdateReleaseArtifacts({ releaseDir, channel, expectedVersion: appVersion });
    console.log(`UPDATE_RELEASE_ARTIFACTS_OK channel=${channel} version=${result.version} metadata=${result.metadata} blockmap=1 publisher=1 sha512=1`);
    return;
  }
  throw new Error('用法：node scripts/update-release-preflight.mjs --preflight | --artifacts --channel <stable|beta> [--dir <release-dir>]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
