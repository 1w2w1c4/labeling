import type {
  Annotation,
  DefectClass,
  Facets,
  Filters,
  ListItem,
  LockState,
  LotInfo,
  Me,
  Neighbors,
  Page,
  QueueNext,
  SaveBody,
  Stats,
} from './types';

const BASE = '/api';

// 只限開發：指定身分（正式環境由反向代理帶入身分 header，這個值必須留空）
const DEV_USER = import.meta.env.VITE_DEV_USER_ID as string | undefined;

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function headers(json = false): HeadersInit {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (DEV_USER) h['X-User-Id'] = DEV_USER;
  return h;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError(0, '無法連線到伺服器，請確認網路或後端是否啟動', {});
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const detail = obj.detail;
    const msg =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? '送出的資料格式不正確'
          : `伺服器錯誤（${res.status}）`;
    throw new ApiError(res.status, msg, obj);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request<Me>('GET', '/me'),
  classes: () => request<DefectClass[]>('GET', '/classes'),

  lot: (lot: string) => request<LotInfo>('GET', `/lots/${enc(lot)}`),
  openLot: (lot: string) => request<LotInfo>('POST', `/lots/${enc(lot)}/open`),
  annotations: (lot: string, f: Filters, cursor: string | null, limit = 200) =>
    request<Page<ListItem>>('GET', `/lots/${enc(lot)}/annotations${qs({ ...f, cursor, limit })}`),
  facets: (lot: string, f: Filters) => request<Facets>('GET', `/lots/${enc(lot)}/facets${qs({ ...f })}`),
  queueNext: (lot: string, exclude?: string) =>
    request<QueueNext>('POST', `/lots/${enc(lot)}/queue/next${qs({ exclude })}`),

  annotation: (id: string) => request<Annotation>('GET', `/annotations/${enc(id)}`),
  save: (id: string, body: SaveBody) => request<Annotation>('PUT', `/annotations/${enc(id)}`, body),
  lock: (id: string, action: 'acquire' | 'renew' | 'release' | 'status', keepalive = false) =>
    request<LockState>('POST', `/annotations/${enc(id)}/lock`, { action }, keepalive ? { keepalive: true } : undefined),
  neighbors: (id: string, mode: 'lot' | 'class', f: Partial<Filters>) =>
    request<Neighbors>('GET', `/annotations/${enc(id)}/neighbors${qs({ mode, ...f })}`),

  stats: (refresh = false) => request<Stats>('GET', `/stats${refresh ? '?refresh=true' : ''}`),
  classImages: (classId: number, cursor: string | null, limit = 200) =>
    request<Page<ListItem>>('GET', `/classes/${classId}/images${qs({ cursor, limit })}`),
};
