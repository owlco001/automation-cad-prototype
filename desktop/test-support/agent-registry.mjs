// 工具注册表的单一事实来源：测试里不要再写死 25 / 12 / 13。
// 直接构造真实 AgentTools 实例读取注册表，避免用正则猜源码。
import { AgentTools } from '../src/agent/tools.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../src/agent/router.ts';

/** 排序后的注册表名 / 只读名单 / 写名单，全部来自运行时对象。 */
export function agentRegistry() {
  const names = new AgentTools({ listParts: () => [] })
    .list()
    .map((tool) => tool.name)
    .sort();
  return {
    names,
    total: names.length,
    readOnly: [...READ_ONLY_TOOLS].sort(),
    write: [...WRITE_TOOLS].sort()
  };
}

/** 工具总数（含只读与写）。 */
export function agentToolTotal() {
  return agentRegistry().total;
}
