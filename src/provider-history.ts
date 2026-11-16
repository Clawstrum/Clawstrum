import type { ProviderEvent } from './types.js';

/** Batch stream deltas without discarding interrupted output. Completed items supersede their
 * buffered fragments; already persisted fragments share one logical byte counter with the item. */
export class StreamHistory {
  private items = new Map<
    string,
    { method: string; text: string; offset: number; bytes: number; at: number }
  >();
  constructor(
    private emit: (event: ProviderEvent) => void,
    private source: () => string,
  ) {}
  delta(id: string, method: string, text: string): void {
    const item = this.items.get(id) ?? { method, text: '', offset: 0, bytes: 0, at: Date.now() };
    item.text += text;
    item.bytes += Buffer.byteLength(text);
    this.items.set(id, item);
    if (Date.now() - item.at >= 1000 || item.text.length >= 32000) this.flush(id);
  }
  completed(id: string): void {
    this.items.delete(id);
  }
  flush(id?: string): void {
    for (const [key, item] of this.items) {
      if ((id && key !== id) || !item.text) continue;
      this.emit({
        type: 'history',
        detail: {
          id: `codex:${this.source()}:${key}`,
          kind: 'provider_partial',
          source: this.source(),
          content: { method: item.method, itemId: key, offset: item.offset, delta: item.text },
          counted: true,
          countedBytes: item.bytes,
        },
      });
      item.offset += item.text.length;
      item.text = '';
      item.at = Date.now();
    }
  }
}
