/**
 * In-memory path along next_id / previous_id — same model as the Next.js app.
 * Identity is always by capture id; never bare array index.
 *
 * Records are feature `properties` objects (imageUrl_Comp, next_id, …)
 * so the rest of v2 (PannellumViewer, pickCompUrl) keeps working unchanged.
 */

import { swapIdInUrl } from './panoUrl';

export const PRELOAD_RADIUS = 4;

/** Optimistic neighbour props by swapping ids inside the current URLs. */
export function syntheticNeighbor(id, from) {
  if (!id || !from) return null;
  // Chain links: the proven link always wins — the tile/API property that
  // produced this step (from.next_id === id, or previous_id) pins the link
  // back to `from`. The OTHER side must never be undefined: the ground
  // arrows read next_id/previous_id, and an undefined link turned the arrow
  // off the moment an un-reconciled frame was revealed ("arrow vanished
  // after one click"). Fall back to the numeric pattern guess (same as the
  // ground-truth app lib/captures.ts). A guessed gap frame just fails that
  // one step (engine reports it); the fetchFeatureCached reconcile in
  // page.js replaces guesses with the authoritative chain right after.
  const isNext = from.next_id === id;
  const isPrev = from.previous_id === id;
  // Numeric pattern guess: `671_125` -> prev `671_124`, next `671_126`.
  const m = /^(\d+)_(\d+)$/.exec(String(id));
  const guessPrev = m ? `${m[1]}_${Number(m[2]) - 1}` : undefined;
  const guessNext = m ? `${m[1]}_${Number(m[2]) + 1}` : undefined;
  return {
    ...from,
    id,
    synthetic: true,
    imageUrl_Comp:
      swapIdInUrl(from.imageUrl_Comp, from.id, id) || from.imageUrl_Comp,
    imageUrl_High:
      swapIdInUrl(from.imageUrl_High, from.id, id) || from.imageUrl_High,
    r2Url_Comp: swapIdInUrl(from.r2Url_Comp, from.id, id) || from.r2Url_Comp,
    r2Url_High: swapIdInUrl(from.r2Url_High, from.id, id) || from.r2Url_High,
    next_id: isPrev ? from.id : guessNext,
    previous_id: isNext ? from.id : guessPrev,
  };
}

export function resolveCapture(id, from, registry) {
  if (!id) return null;
  return registry.get(id) || syntheticNeighbor(id, from);
}

export class PathStore {
  constructor(registry = new Map()) {
    this.registry = registry;
    this.files = [];
    this.currentId = null;
  }

  get current() {
    if (!this.currentId) return null;
    return (
      this.registry.get(this.currentId) ||
      this.files.find((f) => f.id === this.currentId) ||
      null
    );
  }

  indexOf(id) {
    return this.files.findIndex((f) => f.id === id);
  }

  /** Register a full properties object from tile / API. */
  register(props) {
    if (!props?.id) return;
    this.registry.set(props.id, props);
  }

  reset(start) {
    if (!start?.id) return;
    this.register(start);
    this.files = [start];
    this.currentId = start.id;
    if (start.next_id) {
      const n = resolveCapture(start.next_id, start, this.registry);
      if (n) {
        this.register(n);
        this.files.push(n);
      }
    }
    if (start.previous_id) {
      const p = resolveCapture(start.previous_id, start, this.registry);
      if (p) {
        this.register(p);
        this.files.unshift(p);
      }
    }
  }

  clear() {
    this.files = [];
    this.currentId = null;
  }

  /** Expand path ±radius from ends (Next.js PathStore.extend). */
  extend(radius = PRELOAD_RADIUS + 1) {
    if (!this.currentId || !this.files.length) return;
    for (let n = 0; n < radius; n++) {
      const last = this.files[this.files.length - 1];
      if (!last?.next_id) break;
      if (this.files.some((f) => f.id === last.next_id)) break;
      const rec = resolveCapture(last.next_id, last, this.registry);
      if (!rec) break;
      this.register(rec);
      this.files.push(rec);
    }
    for (let n = 0; n < radius; n++) {
      const first = this.files[0];
      if (!first?.previous_id) break;
      if (this.files.some((f) => f.id === first.previous_id)) break;
      const rec = resolveCapture(first.previous_id, first, this.registry);
      if (!rec) break;
      this.register(rec);
      this.files.unshift(rec);
    }
  }

  /**
   * Move along the graph: +1 = next_id, -1 = previous_id.
   * Same contract as Next.js PathStore.step.
   */
  step(dir) {
    const cur = this.current;
    if (!cur) return null;
    const targetId = dir > 0 ? cur.next_id : cur.previous_id;
    if (!targetId) return null;

    if (this.indexOf(targetId) < 0) {
      const n = resolveCapture(targetId, cur, this.registry);
      if (!n) return null;
      this.register(n);
      if (dir > 0) this.files.push(n);
      else this.files.unshift(n);
    }

    this.currentId = targetId;
    this.extend(PRELOAD_RADIUS);
    return this.current;
  }

  setCurrent(id) {
    if (!id) return;
    this.currentId = id;
    if (this.indexOf(id) < 0) {
      const rec = this.registry.get(id);
      if (rec) this.files.push(rec);
    }
    this.extend(PRELOAD_RADIUS);
  }
}
