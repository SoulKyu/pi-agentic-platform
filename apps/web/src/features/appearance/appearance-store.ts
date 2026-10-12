import type { AccountAppearance } from "@pap/contracts";
import { create } from "zustand";
import type { AccountStatus } from "../../lib/account-setting.ts";
import { reportClientIssue } from "../../lib/report.ts";
import {
  ACCOUNT_CACHE_KEY,
  DEFAULT_ACCOUNT,
  DEFAULT_DEVICE,
  DEVICE_KEY,
  parseAccount,
  parseDevice,
  type DeviceAppearance,
} from "./model.ts";

interface AppearanceState {
  readonly account: AccountAppearance;
  readonly device: DeviceAppearance;
  readonly accountStatus: AccountStatus;
  readonly deviceStored: boolean;
  setAccount(next: AccountAppearance): void;
  setDevice(next: DeviceAppearance): void;
  /** A server copy (already merged): cached locally; its status is the account document's to report. */
  replaceFromServer(account: AccountAppearance): void;
  setAccountStatus(status: AccountStatus): void;
  /** Defaults for both scopes, keeping the custom theme library (owner R3-2); returns the previous values for Undo. */
  resetAll(): { account: AccountAppearance; device: DeviceAppearance };
}

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // a locked-down browser: defaults, already reported by the boot path
  }
};
const write = (key: string, value: unknown): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    reportClientIssue("storage_refused");
    return false;
  }
};
const cachedAccount = (): AccountAppearance => {
  const raw = read(ACCOUNT_CACHE_KEY);
  try {
    return parseAccount(raw === null ? null : JSON.parse(raw));
  } catch {
    return DEFAULT_ACCOUNT; // unreadable JSON: the server copy replaces it at the next sync
  }
};

export const useAppearanceStore = create<AppearanceState>()((set, get) => ({
  account: cachedAccount(),
  device: parseDevice(read(DEVICE_KEY)),
  accountStatus: "local",
  deviceStored: true,
  setAccount: (account) => {
    write(ACCOUNT_CACHE_KEY, account);
    set({ account });
  },
  setDevice: (device) => set({ device, deviceStored: write(DEVICE_KEY, device) }),
  replaceFromServer: (account) => {
    write(ACCOUNT_CACHE_KEY, account);
    set({ account });
  },
  setAccountStatus: (accountStatus) => set({ accountStatus }),
  resetAll: () => {
    const previous = { account: get().account, device: get().device };
    get().setAccount({ ...DEFAULT_ACCOUNT, customThemes: previous.account.customThemes });
    get().setDevice(DEFAULT_DEVICE);
    return previous;
  },
}));
