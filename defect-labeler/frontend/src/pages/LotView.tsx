import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../api/client';
import type { Facets, FilterKey, ListItem, LotInfo } from '../api/types';
import { Combo } from '../components/Combo';
import { GridTools, ImageGrid, readDensity, type Density } from '../components/ImageGrid';
import { EmptyPanel, ProgressBar, Spinner } from '../components/Shell';
import {
  AI_CMP,
  aiLabel,
  FILTER_KEYS,
  fmt,
  hasFilters,
  LOT_RE,
  readFilters,
  VERDICT,
  verdictKey,
} from '../lib/format';
import { toast, useSession } from '../store/session';

const COMPACT = 8; // 缺點類別、AI 結果只顯示張數最多的 8 個，其餘用搜尋

interface Opt {
  v: string;
  label: string;
  color?: string;
  inactive?: boolean;
  tip?: string;
}

export default function LotView() {
  const { lot: rawLot = '' } = useParams();
  const lot = rawLot.toUpperCase();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { classes, can } = useSession();
  const filters = useMemo(() => readFilters(params), [params]);
  const queue = params.get('queue') === '1';

  const [info, setInfo] = useState<LotInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [density, setDensity] = useState<Density>(readDensity);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    document.title = `${lot} · 圖片清單`;
    if (!LOT_RE.test(lot)) {
      setLoadErr(`Lot 編號「${lot || '（空白）'}」格式不正確。`);
      return;
    }
    api.lot(lot).then(
      (i) => {
        if (i.status !== 'open') setLoadErr(`Lot「${lot}」尚未開啟，請先回主頁開啟。`);
        setInfo(i);
      },
      (e) => setLoadErr(e instanceof ApiError ? e.message : String(e)),
    );
  }, [lot]);

  const filterKey = FILTER_KEYS.map((k) => filters[k]).join('|');
  useEffect(() => {
    if (info?.status !== 'open') return;
    let alive = true;
    api.facets(lot, filters).then(
      (f) => alive && setFacets(f),
      (e) => toast(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot, filterKey, info?.status]);

  const startQueue = useCallback(async () => {
    setStarting(true);
    try {
      const q = await api.queueNext(lot);
      if (!q.id) {
        toast('這個 Lot 已經沒有待標註的圖');
        if (queue) setParams({}, { replace: true });
        return;
      }
      navigate(`/lots/${encodeURIComponent(lot)}/a/${q.id}?queue=1`, { replace: queue });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [lot, navigate, queue, setParams]);

  // 從主頁「開始標註」進來：直接拿佇列的第一張
  useEffect(() => {
    if (queue && info?.status === 'open') void startQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, info?.status]);

  const setFilter = (k: FilterKey, v: string) => {
    const next = new URLSearchParams(params);
    next.delete('queue');
    if (v === '' || filters[k] === v) next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
  };
  const clear = () => setParams({}, { replace: true });

  const fetchPage = useCallback(
    (cursor: string | null, limit: number) => api.annotations(lot, filters, cursor, limit),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lot, filterKey],
  );

  const open = (it: ListItem) => {
    const q = new URLSearchParams();
    for (const k of FILTER_KEYS) if (filters[k]) q.set(k, filters[k]);
    navigate(`/lots/${encodeURIComponent(lot)}/a/${it.id}${q.toString() ? `?${q}` : ''}`);
  };

  if (loadErr)
    return (
      <div className="page">
        <Crumb />
        <EmptyPanel>
          <div style={{ fontSize: 16, color: 'var(--text)' }}>{loadErr}</div>
          <Link className="btn btn-primary" to="/">
            回主頁
          </Link>
        </EmptyPanel>
      </div>
    );
  if (!info || queue)
    return (
      <div className="page">
        <Crumb />
        <div className="more">
          <Spinner dark />
          {queue ? '正在找下一張待標註的圖…' : '載入中…'}
        </div>
      </div>
    );

  const p = info.progress!;
  const meta = info.meta as { product?: string; station?: string };
  const opts: Record<FilterKey, Opt[]> = {
    verdict: (['NG', 'OK', 'none'] as const).map((v) => ({ v, label: VERDICT[v].label })),
    class_id: classes.map((c) => ({ v: String(c.id), label: c.display, color: c.color, inactive: !c.active })),
    ai: [
      { v: 'OK', label: 'OK' },
      ...classes.map((c) => ({ v: String(c.id), label: c.display, color: c.color, inactive: !c.active })),
    ],
    ai_cmp: (Object.keys(AI_CMP) as (keyof typeof AI_CMP)[]).map((v) => ({
      v,
      label: AI_CMP[v].label,
      color: AI_CMP[v].color,
      tip: AI_CMP[v].tip,
    })),
  };

  return (
    <div className="page">
      <Crumb />
      <section className="panel lot-head">
        <div>
          <div>
            <span className="lot-title mono">{lot}</span>
            <span className="badge b-green">已開啟</span>
          </div>
          <div className="lot-meta">
            {meta.product ?? '—'} · {meta.station ?? '—'} · {fmt(info.image_count)} 張 · {info.online} 人線上
          </div>
        </div>
        <div className="lot-prog">
          <div className="top">
            <span>標註進度</span>
            <span>
              {fmt(p.done)} / {fmt(p.total)}（{p.total ? ((p.done / p.total) * 100).toFixed(1) : 0}%）
            </span>
          </div>
          <ProgressBar ng={p.ng} ok={p.ok} total={p.total} />
          <div className="legend">
            <span>
              <i className="dot" style={{ background: 'var(--danger)' }} />
              NG {fmt(p.ng)}
            </span>
            <span>
              <i className="dot" style={{ background: 'var(--ok)' }} />
              OK {fmt(p.ok)}
            </span>
            <span>
              <i className="dot" style={{ background: 'var(--border)' }} />
              未標 {fmt(p.total - p.done)}
            </span>
          </div>
        </div>
        <div className="lot-actions">
          <Link className="btn btn-ghost" to="/stats">
            缺點分布統計
          </Link>
          {can('annotate') && (
            <button className="btn btn-primary" onClick={startQueue} disabled={starting}>
              {starting && <Spinner />}開始標註
            </button>
          )}
        </div>
      </section>

      <section className="panel filters">
        {(
          [
            ['verdict', '判定'],
            ['class_id', '缺點類別'],
            ['ai', 'AI 結果'],
            ['ai_cmp', 'AI vs 人工'],
          ] as [FilterKey, string][]
        ).map(([key, label]) => (
          <FilterRow
            key={key}
            k={key}
            label={label}
            opts={opts[key]}
            value={filters[key]}
            facets={facets}
            onPick={(v) => setFilter(key, v)}
            classes={classes}
          />
        ))}
      </section>

      <div className="toolbar">
        <div>
          符合 <b>{total == null ? '…' : fmt(total)}</b> 張
          {hasFilters(filters) && <a onClick={clear}>清除篩選</a>}
        </div>
        <GridTools showBoxes={showBoxes} setShowBoxes={setShowBoxes} density={density} setDensity={setDensity} />
      </div>

      <ImageGrid
        resetKey={`${lot}|${filterKey}`}
        fetchPage={fetchPage}
        onTotal={setTotal}
        onOpen={open}
        highlightClass={filters.class_id !== '' ? Number(filters.class_id) : null}
        showBoxes={showBoxes}
        showSeq
        density={density}
        empty={
          <EmptyPanel>
            沒有符合條件的圖片
            <br />
            <button className="btn btn-ghost" onClick={clear}>
              清除篩選
            </button>
          </EmptyPanel>
        }
        renderInfo={(it) => {
          const v = VERDICT[verdictKey(it.verdict)];
          const cmp = it.ai_cmp ? AI_CMP[it.ai_cmp] : null;
          return (
            <>
              <div className="r1">
                <span className="fn mono">{it.filename}</span>
                <span className="nbx">{it.defect_count ? `${it.defect_count} 框` : ''}</span>
              </div>
              <div className="r2">
                <span className={`badge ${v.cls}`}>{v.label}</span>
                <span className="ai" title={`AI 分類結果與信心分數${cmp ? `｜${cmp.tip}` : ''}`}>
                  AI：{aiLabel(it.ai, classes)}{' '}
                  {it.ai?.score != null && <span className="sc">{Number(it.ai.score).toFixed(2)}</span>}
                  {cmp && (
                    <>
                      {' · '}
                      <b style={{ color: cmp.color }}>{cmp.label}</b>
                    </>
                  )}
                </span>
              </div>
            </>
          );
        }}
      />
    </div>
  );
}

function Crumb() {
  return (
    <nav className="crumb">
      <Link to="/">主頁</Link> › Lot 圖片清單
    </nav>
  );
}

function FilterRow({
  k,
  label,
  opts,
  value,
  facets,
  onPick,
  classes,
}: {
  k: FilterKey;
  label: string;
  opts: Opt[];
  value: string;
  facets: Facets | null;
  onPick: (v: string) => void;
  classes: { id: number; name: string }[];
}) {
  const fc = facets?.[k];
  const n = (v: string) => fc?.counts[v] ?? 0;
  const compact = k === 'class_id' || k === 'ai';
  let visible = opts;
  if (compact) {
    const top = opts
      .filter((o) => o.v !== 'OK' && n(o.v) > 0)
      .sort((a, b) => n(b.v) - n(a.v))
      .slice(0, COMPACT);
    visible = opts.filter((o) => o.v === 'OK' || o.v === value || top.includes(o));
  }
  return (
    <div className="frow">
      <span className="flabel">{label}</span>
      <div className="chips">
        <button className={`chip ${value === '' ? 'active' : ''}`} onClick={() => onPick('')}>
          全部 <span className="cnt">{fc ? fmt(fc.all) : '…'}</span>
        </button>
        {visible.map((o) => (
          <button
            key={o.v}
            className={`chip ${value === o.v ? 'active' : ''} ${n(o.v) ? '' : 'zero'} ${o.inactive ? 'inactive' : ''}`}
            title={o.tip}
            onClick={() => onPick(o.v)}
          >
            {o.color && <span className="sw" style={{ background: o.color }} />}
            <span className="nm">{o.label}</span> <span className="cnt">{fc ? fmt(n(o.v)) : '…'}</span>
          </button>
        ))}
        {compact && (
          <span className="fcombo">
            <Combo
              placeholder={`搜尋其他類別（共 ${classes.length} 種）…`}
              items={opts
                .filter((o) => o.v !== 'OK')
                .map((o) => ({
                  v: o.v,
                  label: o.label,
                  sub: classes[Number(o.v)]?.name,
                  color: o.color,
                  count: n(o.v),
                  inactive: o.inactive,
                }))}
              onPick={onPick}
            />
          </span>
        )}
      </div>
    </div>
  );
}
