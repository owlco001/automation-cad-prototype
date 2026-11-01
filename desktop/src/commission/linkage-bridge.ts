// 联动面板 ↔ 3D 场景的桥（单独成文件是为了能单测：
// commission/ui.ts 里直接写 window 顶层赋值，测试没法验证"重建后是否还指向新场景"）。

export interface LinkagePose {
  offsets?: Record<string, number[]>;
  rotZDeg?: Record<string, number>;
}

export interface PoseTarget {
  applyLinkagePose(pose: LinkagePose): number;
}

/**
 * 在 `win` 上挂 `__cadApplyLinkagePose`，每次调用都**现取**场景：
 * 视口重建（切机型 / 重排布）后 scene 会被 dispose 再新建，
 * 如果闭包抓住旧实例，面板播放就会静默不动——这是最难查的一类 bug。
 */
export function registerLinkagePoseBridge(
  win: { __cadApplyLinkagePose?: (pose: LinkagePose) => void },
  getScene: () => PoseTarget | null | undefined
): void {
  win.__cadApplyLinkagePose = (pose: LinkagePose) => {
    const scene = getScene();
    if (!scene) return;
    scene.applyLinkagePose(pose ?? {});
  };
}
