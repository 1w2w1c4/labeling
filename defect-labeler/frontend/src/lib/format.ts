import type { AiCmp, AiResult, DefectClass, FilterKey, Filters, Verdict } from '../api/types';

export const fmt = (n: number) => n.toLocaleString('en-US');

export const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

// ---------- Lot 編號 ----------

export const LOT_RE = /^[A-Z0-9]{6}-[A-Z0-9]{2}-[A-Z0-9]{2}$/;

/** 只保留英數字，依 6-2-2 自動補上 - */
export function autoFormatLot(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  return [s.slice(0, 6), s.slice(6, 8), s.slice(8, 10)].filter(Boolean).join('-');
}

// ---------- 判定與 AI ----------

export const VERDICT: Record<Verdict | 'none', { label: string; cls: string }> = {
  NG: { label: 'NG', cls: 'b-red' },
  OK: { label: 'OK', cls: 'b-green' },
  none: { label: '未判定', cls: 'b-gray' },
};

export const verdictKey = (v: Verdict | null) => v ?? 'none';

export const AI_CMP: Record<AiCmp, { label: string; color: string; tip: string }> = {
  escape: { label: '逃漏', color: 'var(--danger)', tip: 'AI 判 OK，人工判 NG' },
  overkill: { label: '過殺', color: 'var(--warn)', tip: 'AI 判缺點，人工判 OK' },
  mismatch: { label: '類別不符', color: 'var(--purple)', tip: 'AI 與人工都判 NG，但類別不同' },
};

export function aiLabel(ai: AiResult | null | undefined, classes: DefectClass[]): string {
  const r = ai?.result;
  if (r == null || r === '') return '—';
  if (r.toUpperCase() === 'OK') return 'OK';
  const c = /^\d+$/.test(r) ? classes[Number(r)] : undefined;
  return c ? c.display : r;
}

/** 和後端 compute_ai_cmp 相同的規則（標註頁即時顯示用） */
export function computeAiCmp(verdict: Verdict | null, ai: AiResult | null, classIds: number[]): AiCmp | null {
  const r = ai?.result;
  if (!verdict || r == null || r === '') return null;
  const aiOk = r.toUpperCase() === 'OK';
  if (verdict === 'NG' && aiOk) return 'escape';
  if (verdict === 'OK' && !aiOk) return 'overkill';
  if (verdict === 'NG' && !aiOk && /^\d+$/.test(r)) return classIds.includes(Number(r)) ? null : 'mismatch';
  return null;
}

// ---------- 時間 ----------

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 篩選（URL query string） ----------

export const FILTER_KEYS: FilterKey[] = ['verdict', 'class_id', 'ai', 'ai_cmp'];

export function readFilters(params: URLSearchParams): Filters {
  return {
    verdict: params.get('verdict') ?? '',
    class_id: params.get('class_id') ?? '',
    ai: params.get('ai') ?? '',
    ai_cmp: params.get('ai_cmp') ?? '',
  };
}

export const hasFilters = (f: Filters) => FILTER_KEYS.some((k) => f[k] !== '');

/** 類別搜尋：中文名稱、英文代碼、id 都可以；開頭符合的排前面（2 > 1 > 0） */
export function matchScore(q: string, ...hay: string[]): number {
  const s = q.trim().toLowerCase();
  if (!s) return 1;
  const h = hay.map((x) => x.toLowerCase());
  if (h.some((x) => x.startsWith(s))) return 2;
  if (h.some((x) => x.includes(s))) return 1;
  return 0;
}
