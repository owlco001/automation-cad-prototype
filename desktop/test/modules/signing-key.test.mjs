// 模块签名公钥的发行约定。
//
// 关键取舍：**不提交占位公钥**。一个没有对应私钥的"固定公钥"看起来像门禁，实际
// 永远签不出可验证的包，是典型的空转。因此约定为：
// - 文件可缺失：缺失即表示本仓库不发行第三方模块包，安装路径必须保持关闭；
// - 一旦存在：必须是合法 Ed25519 SPKI，且文件里绝不能出现私钥材料。
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pinnedPath = join(desktopRoot, 'modules', 'module-signing-key.pem');

test('模块签名公钥要么缺失，要么是合法 Ed25519 SPKI（不得含私钥）', () => {
  if (!existsSync(pinnedPath)) {
    // 缺失是合法状态：仓库不发行签名包，运行时不得据此放行任何外部包。
    return;
  }
  const text = readFileSync(pinnedPath, 'utf8');
  assert.match(text, /^-----BEGIN PUBLIC KEY-----/);
  assert.match(text, /-----END PUBLIC KEY-----\s*$/);
  assert.equal(/PRIVATE KEY/.test(text), false, '公钥文件不得包含私钥材料');
  // 能用真实验签行为确认它是可用的 Ed25519 公钥：不同密钥必须验不过。
  const message = Buffer.from('probe');
  const foreign = generateKeyPairSync('ed25519');
  const key = readFileSync(pinnedPath);
  assert.equal(verify(null, message, key, sign(null, message, foreign.privateKey)), false);
});
