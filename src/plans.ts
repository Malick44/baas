export type Plan = {
  requestsPerDay: number;
  rps: number;
  burst: number;
  dbBytes: number;
  storageBytes: number;
  fileSizeBytes: number;
  /** Auto-pause after this many days with no requests; null disables. */
  idlePauseDays: number | null;
  backupsKept: number;
  scheduledBackups: boolean;
};

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const PLANS: Record<string, Plan> = {
  free: { requestsPerDay: 50_000, rps: 20, burst: 40, dbBytes: 500 * MB, storageBytes: 1 * GB, fileSizeBytes: 50 * MB, idlePauseDays: 7, backupsKept: 3, scheduledBackups: false },
  pro: { requestsPerDay: 5_000_000, rps: 200, burst: 400, dbBytes: 8 * GB, storageBytes: 100 * GB, fileSizeBytes: 50 * MB, idlePauseDays: null, backupsKept: 14, scheduledBackups: true },
};

export const planOf = (name: string): Plan => PLANS[name] ?? PLANS.free!;
