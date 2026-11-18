import { create } from 'zustand';
import { api, ApiError } from '../api/client';
import type { DefectClass, Me, Permission } from '../api/types';

interface SessionState {
  status: 'loading' | 'ready' | 'error';
  me: Me | null;
  classes: DefectClass[];
  error: string | null;
  load: () => Promise<void>;
  can: (p: Permission) => boolean;
}

/** 目前使用者與缺點類別：啟動時載入一次（兩者都只在後端重啟時改變）。 */
export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  me: null,
  classes: [],
  error: null,
  load: async () => {
    set({ status: 'loading', error: null });
    try {
      const [me, classes] = await Promise.all([api.me(), api.classes()]);
      set({ status: 'ready', me, classes });
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 401
          ? `${e.message}。請確認你在 users.yaml 的名單中且沒有停用。`
          : e instanceof Error
            ? e.message
            : String(e);
      set({ status: 'error', error: msg });
    }
  },
  can: (p) => !!get().me?.permissions.includes(p),
}));

// ---------- 提示訊息 ----------

interface ToastState {
  text: string;
  shown: boolean;
  show: (text: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useToast = create<ToastState>((set) => ({
  text: '',
  shown: false,
  show: (text) => {
    clearTimeout(toastTimer);
    set({ text, shown: true });
    toastTimer = setTimeout(() => set({ shown: false }), 2600);
  },
}));

export const toast = (text: string) => useToast.getState().show(text);

// ---------- 對話框 ----------

export interface DialogButton {
  label: string;
  kind?: 'primary' | 'danger' | 'ghost';
  onClick?: () => void;
}

interface DialogState {
  open: boolean;
  title: string;
  message: string;
  buttons: DialogButton[];
  show: (title: string, message: string, buttons: DialogButton[]) => void;
  close: () => void;
}

export const useDialog = create<DialogState>((set) => ({
  open: false,
  title: '',
  message: '',
  buttons: [],
  show: (title, message, buttons) => set({ open: true, title, message, buttons }),
  close: () => set({ open: false }),
}));

export const showDialog = (title: string, message: string, buttons: DialogButton[]) =>
  useDialog.getState().show(title, message, buttons);
