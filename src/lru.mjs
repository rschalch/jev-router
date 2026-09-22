/**
 * A Map capped at `limit` entries that evicts the least recently used one first. Reading an
 * entry refreshes it, so a conversation that keeps making requests is never evicted by the
 * sub-agents it spawns, however many there are.
 */
export class LruMap extends Map {
  constructor(limit) {
    super();
    this.limit = limit;
  }

  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }

  set(key, value) {
    super.delete(key);
    if (this.size >= this.limit) super.delete(this.keys().next().value);
    return super.set(key, value);
  }
}
