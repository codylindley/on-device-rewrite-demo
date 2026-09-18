import type { DownloadOffer } from "../types.ts";

export function createDownloadGate(onRequired: (offer: DownloadOffer) => void) {
  const approved = new Set<string>();
  let pending: { offer: DownloadOffer; promise: Promise<void>; resolve(): void } | null = null;

  return {
    wait(offer: DownloadOffer): Promise<void> {
      if (approved.has(offer.key)) return Promise.resolve();
      if (pending) {
        if (pending.offer.key !== offer.key) {
          return Promise.reject(new Error("Another model download is awaiting approval."));
        }
        return pending.promise;
      }
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      pending = { offer, promise, resolve: release };
      onRequired(offer);
      return promise;
    },
    approve(key: string): boolean {
      if (!pending || pending.offer.key !== key) return false;
      approved.add(key);
      const waiting = pending;
      pending = null;
      waiting.resolve();
      return true;
    },
  };
}
