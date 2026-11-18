/**
 * 「本文件里不许散落同步子进程」这条静态守卫的**唯一实现**。
 *
 * 为什么单独一个模块：以前 `cli.test.mjs` 的守卫和它的「负例」各写一份同样的正则。
 * 负例拿自己的副本去验自己，守卫退化成 `execFileSync\(` 时两条测试**同时绿** ——
 * 负向自证变成了自证同义反复。现在两边共用一个函数：
 * 函数一旦退化，主断言（本文件命中数）和负例（伪造源码的行为）会一起红。
 *
 * 口径：先剥注释（注释里会讲到这些 API），再数「函数名紧跟左括号」的调用点。
 * 名字只出现在字符串/属性里不算调用点（`'spawnSync'`、`foo.execSyncX(` 都不该被数）。
 */
export function scanSyncSubprocessSites(source) {
  const code = String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/\b(execFileSync|spawnSync|execSync)\s*\(/g)].map((match) => match[1]);
}
