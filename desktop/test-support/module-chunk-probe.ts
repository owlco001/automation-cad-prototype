// 仅测试用：给分块构建/加载链路提供一个小而真实的可执行分块。
// 不进入发布产物（modules/chunks.json 默认为空），避免把探针当作产品模块发出去。
export const probe = {
  id: 'test.probe',
  ping(value: number): number {
    return value + 1;
  }
};

export default probe;
