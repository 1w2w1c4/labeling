import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { UserRef } from '../api/types';

const HEARTBEAT_MS = 60_000; // 鎖 300 秒，每 60 秒續約一次

export type LockStatus = 'off' | 'pending' | 'held' | 'blocked' | 'error';

export interface EditLock {
  status: LockStatus;
  holder: UserRef | null; // blocked 時為正在編輯的人
  degraded: boolean; // Redis 無法使用：沒有鎖，只靠版本檢查
  error: string | null;
}

/**
 * 進入標註頁即取得編輯鎖，停留期間自動續約（心跳），離開時釋放。
 * enabled=false（沒有 annotate 權限）時不取得鎖，頁面為唯讀。
 */
export function useEditLock(annId: string, enabled: boolean): EditLock {
  const [state, setState] = useState<EditLock>({
    status: enabled ? 'pending' : 'off',
    holder: null,
    degraded: false,
    error: null,
  });
  const held = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const apply = (r: Awaited<ReturnType<typeof api.lock>>) => {
      if (!alive) return;
      held.current = r.held;
      setState({ status: r.held ? 'held' : 'blocked', holder: r.holder, degraded: r.degraded, error: null });
    };
    const fail = (e: unknown) => {
      if (!alive) return;
      setState((s) => ({ ...s, status: held.current ? s.status : 'error', error: e instanceof Error ? e.message : String(e) }));
    };

    api.lock(annId, 'acquire').then(apply, fail);
    const timer = setInterval(() => {
      // 被別人拿走（例如網路斷太久鎖過期）時 held=false → 畫面改成被鎖住
      api.lock(annId, held.current ? 'renew' : 'acquire').then(apply, fail);
    }, HEARTBEAT_MS);

    const release = () => {
      if (held.current) {
        held.current = false;
        // keepalive：關閉分頁時請求仍會送出
        api.lock(annId, 'release', true).catch(() => undefined);
      }
    };
    window.addEventListener('pagehide', release);

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('pagehide', release);
      release();
    };
  }, [annId, enabled]);

  return state;
}
