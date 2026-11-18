// 與後端 app/models/*.py 對應的型別

export type Permission = 'view' | 'open_lot' | 'annotate';

export interface Me {
  id: string;
  name: string;
  role: string;
  permissions: Permission[];
}

export interface DefectClass {
  id: number;
  name: string;
  display: string;
  color: string;
  active: boolean;
}

export interface UserRef {
  id: string;
  name: string;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Defect {
  id: string;
  class_id: number;
  class_name?: string;
  bbox: BBox;
  attributes: Record<string, unknown>;
}

export type Verdict = 'OK' | 'NG';
export type AiCmp = 'escape' | 'overkill' | 'mismatch';

export interface AiResult {
  result?: string | null;
  score?: number | null;
  model?: string | null;
}

// ---------- Lot ----------

export type LotStatus = 'new' | 'initializing' | 'open' | 'failed';

export interface Progress {
  total: number;
  done: number;
  ok: number;
  ng: number;
}

export interface LotInfo {
  lot: string;
  status: LotStatus;
  image_count: number;
  meta: Record<string, unknown>;
  data_source: 'redis' | 'mongo' | 'annotations';
  init: { done: number; total: number } | null;
  progress: Progress | null;
  online: number;
  error: string | null;
}

// ---------- 標註 ----------

export interface ImageInfo {
  path: string;
  filename: string;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface Annotation {
  id: string;
  lot: string;
  seq: number;
  image_id: string;
  url: string;
  image: ImageInfo;
  meta: Record<string, unknown>;
  extra: Record<string, unknown>;
  ai: AiResult | null;
  ai_cmp: AiCmp | null;
  verdict: Verdict | null;
  defect_count: number;
  defects: Defect[];
  version: number;
  created_at: string | null;
  updated_by: UserRef | null;
  updated_at: string | null;
  locked_by: UserRef | null;
}

export interface ListItem {
  id: string;
  lot: string;
  seq: number;
  filename: string;
  url: string;
  width: number;
  height: number;
  verdict: Verdict | null;
  defect_count: number;
  defects: Defect[];
  ai: AiResult | null;
  ai_cmp: AiCmp | null;
  locked_by: UserRef | null;
  class_boxes?: number; // 類別圖片清單才有
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total: number | null;
}

export interface FacetCounts {
  all: number;
  counts: Record<string, number>;
}

export type FilterKey = 'verdict' | 'class_id' | 'ai' | 'ai_cmp';
export type Filters = Record<FilterKey, string>;
export type Facets = Record<FilterKey, FacetCounts>;

export interface Neighbors {
  prev: string | null;
  next: string | null;
  prev_lot: string | null;
  next_lot: string | null;
  position: number | null;
  total: number;
}

export interface LockState {
  held: boolean;
  holder: UserRef | null;
  expires_in: number | null;
  degraded: boolean;
}

export interface QueueNext {
  id: string | null;
  remaining: number;
}

export interface ClassStat {
  class_id: number;
  boxes: number;
  images: number;
}

export interface Stats {
  images: number;
  labeled: number;
  ng: number;
  ok: number;
  unlabeled: number;
  boxes: number;
  avg_boxes_per_ng: number;
  lots: number;
  classes: ClassStat[];
  cached_at: string;
}

export interface SaveBody {
  version: number;
  defects: { id?: string; class_id: number; bbox: BBox; attributes: Record<string, unknown> }[];
}
