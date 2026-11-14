// A revision in the search fingerprint invalidates both stored cursors and
// cursors created by requests that were still running during a tag mutation.
import { bumpSingleNamedCache } from "@/services/single-named-cache";

let revision = 0;

export function getTagSearchRevision(): number {
  return revision;
}

export function invalidateTagSearch(): void {
  revision++;
  // 标签一变，「多人图只有一个名字」的候选集缓存也要作废（2026-11-14 · 会话#12）
  bumpSingleNamedCache();
}
