/**
 * 条目事件总线（对标 ADS `ldapbrowser.core/events/EventRegistry` 的最小形态）：
 * 写操作（add/modify/delete/move/rename）成功后发出领域事件，由单一订阅点
 * 统一做缓存失效 / 树刷新 / 结果表重放，替代各写路径手工散落的失效调用。
 *
 * 设计约束：
 * - 同步、无依赖、可单测：不引 Vue 响应式，监听器自己决定如何驱动 UI。
 * - 连接隔离：事件携带 connectionId，订阅端负责过滤（跨连接事件直接忽略）。
 * - DN 一律携带原始大小写（展示语义）；订阅端做归一化匹配。
 */

export type EntryEventKind = "changed" | "deleted" | "moved";

export interface EntryEvent {
  kind: EntryEventKind;
  connectionId: string;
  /** 事件主体 DN：changed/deleted 为目标 DN，moved 为移动后的新 DN。 */
  dn: string;
  /** moved 专属：移动/重命名前的原 DN。 */
  previousDn?: string;
  /** deleted/moved 场景下需要级联失效子树时为 true（与 invalidateCache 的 descendants 对齐）。 */
  descendants?: boolean;
}

type EntryEventListener = (event: EntryEvent) => void;

const listeners = new Set<EntryEventListener>();

export function onEntryEvent(listener: EntryEventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitEntryEvent(event: EntryEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // 总线语义：单个订阅者抛错不阻塞其余订阅者（对齐 EventRegistry 的容错分发）。
    }
  }
}

/** 便捷发射器：kind 直接映射，签名对齐既有写路径的调用形态。 */
export function emitEntryChanged(connectionId: string, dn: string): void {
  emitEntryEvent({ kind: "changed", connectionId, dn });
}

export function emitEntryDeleted(connectionId: string, dn: string, descendants: boolean): void {
  emitEntryEvent({ kind: "deleted", connectionId, dn, descendants });
}

export function emitEntryMoved(connectionId: string, previousDn: string, dn: string, descendants: boolean): void {
  emitEntryEvent({ kind: "moved", connectionId, dn, previousDn, descendants });
}

/** 测试隔离用：清空全部监听（生产代码不要调用）。 */
export function resetEntryEvents(): void {
  listeners.clear();
}
