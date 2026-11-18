import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ListItem, Page } from '../api/types';
import { fmt } from '../lib/format';
import { useSession } from '../store/session';
import { Spinner } from './Shell';

export type Density = 's' | 'm' | 'l';
const MIN_CARD: Record<Density, number> = { s: 150, m: 210, l: 300 };
const GAP = 12;
const INFO_H = 62;
const PAGE = 200;

export function readDensity(): Density {
  try {
    const d = localStorage.getItem('dl_density');
    return d === 's' || d === 'm' || d === 'l' ? d : 'm';
  } catch {
    return 'm';
  }
}
export function saveDensity(d: Density) {
  try {
    localStorage.setItem('dl_density', d);
  } catch {
    /* 存不了就算了 */
  }
}

interface Props {
  /** 篩選條件改變時換一個 key，清單會重新從第一頁載入 */
  resetKey: string;
  fetchPage: (cursor: string | null, limit: number) => Promise<Page<ListItem>>;
  onTotal?: (total: number) => void;
  onOpen: (item: ListItem) => void;
  renderInfo: (item: ListItem) => React.ReactNode;
  highlightClass?: number | null; // 只標出這個類別的框，其他變淡
  showBoxes: boolean;
  showSeq?: boolean;
  density: Density;
  empty: React.ReactNode;
}

/**
 * 虛擬捲動的圖格清單：只產生畫面上看得到的那幾排，捲到接近底部時用 cursor 載入下一頁。
 * 圖片直接用原圖（300×300，不需要縮圖）。
 */
export function ImageGrid(p: Props) {
  const classes = useSession((s) => s.classes);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [items, setItems] = useState<ListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0); // 篩選改變後丟掉舊請求的結果
  const fetchRef = useRef(p.fetchPage);
  fetchRef.current = p.fetchPage;
  const onTotalRef = useRef(p.onTotal);
  onTotalRef.current = p.onTotal;

  const load = useCallback(async (from: string | null, g: number) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchRef.current(from, PAGE);
      if (g !== gen.current) return;
      setItems((prev) => (from ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setDone(!page.next_cursor);
      if (page.total != null) {
        setTotal(page.total);
        onTotalRef.current?.(page.total);
      }
    } catch (e) {
      if (g === gen.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const g = ++gen.current;
    setItems([]);
    setCursor(null);
    setDone(false);
    setTotal(null);
    void load(null, g);
  }, [p.resetKey, load]);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((width + GAP) / (MIN_CARD[p.density] + GAP)));
  const cardW = width ? (width - GAP * (cols - 1)) / cols : MIN_CARD[p.density];
  const rowH = cardW + INFO_H + GAP; // 圖片是正方形（300×300）
  const rows = Math.ceil(items.length / cols);

  const virt = useWindowVirtualizer({
    count: rows,
    estimateSize: () => rowH,
    overscan: 2,
    scrollMargin: wrap.current?.offsetTop ?? 0,
  });

  useEffect(() => {
    virt.measure();
  }, [rowH, virt]);

  const vrows = virt.getVirtualItems();
  const lastRow = vrows.length ? vrows[vrows.length - 1].index : -1;
  useEffect(() => {
    if (!done && !loading && !error && cursor && lastRow >= rows - 3) void load(cursor, gen.current);
  }, [lastRow, rows, done, loading, error, cursor, load]);

  if (!loading && !error && items.length === 0 && total === 0) return <>{p.empty}</>;

  return (
    <>
      <div
        ref={wrap}
        className={`vgrid ${p.showBoxes ? '' : 'hide-boxes'}`}
        style={{ height: rows ? rows * rowH - GAP : 0 }}
      >
        {vrows.map((vr) =>
          Array.from({ length: cols }, (_, c) => {
            const it = items[vr.index * cols + c];
            if (!it) return null;
            return (
              <div
                key={`${it.lot}/${it.id}`}
                className="item"
                style={{ top: vr.start - virt.options.scrollMargin, left: c * (cardW + GAP), width: cardW }}
                onClick={() => p.onOpen(it)}
              >
                <div className="thumb" style={{ height: cardW }}>
                  <img src={it.url} alt="" loading="lazy" decoding="async" draggable={false} />
                  {it.defects.map((d) => {
                    const cl = classes[d.class_id];
                    const W = it.width || 300;
                    const H = it.height || 300;
                    const dim = p.highlightClass != null && d.class_id !== p.highlightClass;
                    return (
                      <i
                        key={d.id}
                        className={`bx ${dim ? 'dim' : ''}`}
                        style={{
                          left: `${(d.bbox.x / W) * 100}%`,
                          top: `${(d.bbox.y / H) * 100}%`,
                          width: `${(d.bbox.w / W) * 100}%`,
                          height: `${(d.bbox.h / H) * 100}%`,
                          borderColor: cl?.color ?? '#fff',
                        }}
                      />
                    );
                  })}
                  {it.locked_by && <span className="tag lock">🔒 {it.locked_by.name} 編輯中</span>}
                  {p.showSeq && <span className="tag idx">#{fmt(it.seq)}</span>}
                </div>
                <div className="info">{p.renderInfo(it)}</div>
              </div>
            );
          }),
        )}
      </div>
      <div className="more">
        {error ? (
          <>
            <span style={{ color: 'var(--danger)' }}>載入失敗：{error}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => load(cursor, gen.current)}>
              重試
            </button>
          </>
        ) : loading ? (
          <>
            <Spinner dark />
            {items.length ? `已載入 ${fmt(items.length)}${total != null ? ` / ${fmt(total)}` : ''}，載入更多…` : '載入中…'}
          </>
        ) : done ? (
          `已顯示全部 ${fmt(items.length)} 張`
        ) : (
          `已載入 ${fmt(items.length)}${total != null ? ` / ${fmt(total)}` : ''}，捲動載入更多…`
        )}
      </div>
    </>
  );
}

export function GridTools({
  showBoxes,
  setShowBoxes,
  density,
  setDensity,
}: {
  showBoxes: boolean;
  setShowBoxes: (v: boolean) => void;
  density: Density;
  setDensity: (d: Density) => void;
}) {
  return (
    <div className="tools">
      <label className="switch">
        <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
        顯示框
      </label>
      <div className="seg">
        {(['s', 'm', 'l'] as Density[]).map((d) => (
          <button
            key={d}
            className={density === d ? 'on' : ''}
            onClick={() => {
              setDensity(d);
              saveDensity(d);
            }}
          >
            {{ s: '小', m: '中', l: '大' }[d]}
          </button>
        ))}
      </div>
    </div>
  );
}
