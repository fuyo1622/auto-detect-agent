import type { PushSubscription } from 'web-push';
import type { NotifyPrefs, Settings } from './types.ts';
import { readJsonFile, writeJsonAtomic } from './util.ts';

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  push?: { subscription: PushSubscription; prefs: NotifyPrefs; updatedAt: number };
}

export interface StoreData {
  version: 1;
  vapid?: { publicKey: string; privateKey: string };
  devices: Device[];
  settings: Settings;
  /** Session key -> when the user dismissed it. */
  dismissed: Record<string, number>;
  /** Session key -> when Stop / Reconnect closed it from here (shown as "Stopped", not as a crash). */
  stopped: Record<string, number>;
  /** Claude session records ("pid:procStart") left by a process whose conversation went on in a newer one. */
  superseded: Record<string, number>;
}

export class Store {
  data: StoreData;
  private timer: NodeJS.Timeout | undefined;
  private readonly file: string;

  constructor(file: string, defaults: Settings) {
    this.file = file;
    const loaded = readJsonFile<Partial<StoreData>>(file);
    this.data = {
      version: 1,
      vapid: loaded?.vapid,
      devices: loaded?.devices ?? [],
      settings: { ...defaults, ...(loaded?.settings ?? {}) },
      dismissed: loaded?.dismissed ?? {},
      stopped: loaded?.stopped ?? {},
      superseded: loaded?.superseded ?? {},
    };
  }

  /** Write soon; many changes in a row become one write. */
  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.saveNow();
    }, 200);
  }

  saveNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    writeJsonAtomic(this.file, this.data);
  }
}
