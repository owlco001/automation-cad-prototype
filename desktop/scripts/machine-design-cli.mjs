#!/usr/bin/env node
// 整机方案 CLI：给 Qt 客户端用（也方便脚本/CI）。
// 用法：node scripts/machine-design-cli.mjs --brief "六工位锁螺丝机，节拍 20 件/分钟" [--out case.json] [--quiet]
// 输出：stdout 只有 JSON（machine-case，schemaVersion=1）；日志走 stderr，方便客户端直接 JSON.parse。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildMachineCase } from '../src/machine/case.ts';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.size ? args.at(index + 1) : fallback;
};

const briefIndex = args.indexOf('--brief');
const brief = briefIndex >= 0 && briefIndex + 1 < args.length ? args[briefIndex + 1] : '';
if (!brief.trim()) {
  console.error('FT_MACHINE_CLI_USAGE --brief "一句话需求" [--out path]');
  process.exit(2);
}
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 && outIndex + 1 < args.length ? resolve(args[outIndex + 1]) : null;

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..');
const partsDir = join(repoRoot, 'packs', 'builtin');
const pricebookFile = join(partsDir, 'pricebook-cn', 'pricebook.json');

const { caseData } = buildMachineCase({
  brief,
  partsDir,
  ...(existsSync(pricebookFile) ? { pricebookFile } : {}),
  pricingAssumptions: ['命令行未读取 userData/machine-pricing.json，使用工程默认系数与工时单价。']
});

const json = `${JSON.stringify(caseData, null, 2)}\n`;
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json, 'utf8');
  console.error(`FT_MACHINE_CLI_WROTE ${outFile}`);
}
process.stdout.write(json);
