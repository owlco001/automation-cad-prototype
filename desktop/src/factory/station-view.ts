import type { TagNode, TagValue } from './types.ts';

type Result<T> = { ok: boolean; data?: T; message?: string };

interface StationViewApi {
  browse(): Promise<Result<TagNode[]>>;
  readTags(ids: string[]): Promise<Result<Record<string, TagValue>>>;
  subscribe(ids: string[]): Promise<Result<unknown>>;
}

interface StationView {
  renderStations(stations: TagNode[]): void;
  updateTagValue(value: TagValue): void;
  showError(message: string): void;
}

export async function loadFactoryStationView(api: StationViewApi, view: StationView): Promise<void> {
  const result = await api.browse();
  if (!result.ok) {
    view.showError(result.message ?? '浏览点位失败');
    return;
  }
  const stations: TagNode[] = [];
  const looseTags: TagNode[] = [];
  for (const node of result.data ?? []) {
    if (node.kind === 'station' || node.children?.length) stations.push(node);
    else if (node.kind === 'tag') looseTags.push(node);
  }
  if (looseTags.length) stations.push({ id: 'ungrouped-tags', name: '未分组点位', kind: 'station', children: looseTags });
  view.renderStations(stations);
  const ids = [...new Set(stations.flatMap((station) => (station.children ?? []).map((tag) => tag.id)))];
  if (!ids.length) return;
  const read = await api.readTags(ids);
  if (read.ok && read.data) {
    for (const value of Object.values(read.data)) view.updateTagValue(value);
  }
  const subscribed = await api.subscribe(ids);
  if (!subscribed.ok) view.showError(subscribed.message ?? '订阅点位失败');
}
