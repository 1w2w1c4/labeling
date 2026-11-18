import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/client';
import type { Stats as StatsData } from '../api/types';
import { EmptyPanel, ProgressBar, Spinner } from '../components/Shell';
import { fmt, fmtTime, pct } from '../lib/format';
import { toast, useSession } from '../store/session';

type By = 'boxes' | 'images';

/** 刻度：取 1/2/5 × 10^n 的整齊間距 */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

export default function Stats() {
  const [params, setParams] = useSearchParams();
  const by: By = params.get('by') === 'images' ? 'images' : 'boxes';
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setRefreshing(true);
    try {
      setData(await api.stats(refresh));
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (refresh) toast(msg);
      else setError(msg);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    document.title = '缺點分布統計';
    void load(false);
  }, [load]);

  const crumb = (
    <nav className="crumb">
      <Link to="/">主頁</Link> › 缺點分布統計
    </nav>
  );
  if (error)
    return (
      <div className="page page-narrow">
        {crumb}
        <EmptyPanel>
          <div style={{ fontSize: 16, color: 'var(--text)' }}>{error}</div>
          <button className="btn btn-primary" onClick={() => load(false)}>
            重試
          </button>
        </EmptyPanel>
      </div>
    );
  if (!data)
    return (
      <div className="page page-narrow">
        {crumb}
        <div className="more">
          <Spinner dark />
          統計中…
        </div>
      </div>
    );
  if (!data.lots)
    return (
      <div className="page page-narrow">
        {crumb}
        <EmptyPanel>
          <div style={{ fontSize: 16, color: 'var(--text)' }}>目前沒有已開啟的 Lot，沒有可統計的資料。</div>
          <Link className="btn btn-primary" to="/">
            回主頁
          </Link>
        </EmptyPanel>
      </div>
    );

  const S = data;
  return (
    <div className="page page-narrow stats">
      {crumb}
      <section className="panel" style={{ marginTop: 0 }}>
        <div className="scope">
          <div>
            <h1>缺點分布統計</h1>
            <div className="hint" style={{ marginTop: 4 }}>
              統計範圍：全部已開啟的 Lot（{S.lots} 個）
            </div>
          </div>
          <div className="cache">
            統計結果快取 60 秒 · 更新於 {fmtTime(S.cached_at).slice(11)}
            <button className="btn btn-ghost btn-sm" onClick={() => load(true)} disabled={refreshing}>
              {refreshing && <Spinner dark />}重新整理
            </button>
          </div>
        </div>
      </section>

      <section className="panel overview">
        <div className="sec-head">
          <h2>總覽</h2>
        </div>
        <div className="kpis">
          <Kpi k="圖片數" v={S.images} s={`${S.lots} 個 Lot`} />
          <Kpi k="已標註" v={S.labeled} s={pct(S.labeled, S.images)} />
          <Kpi k="NG" dot="var(--danger)" v={S.ng} s={`已標註的 ${pct(S.ng, S.labeled)}`} />
          <Kpi k="OK" dot="var(--ok)" v={S.ok} s={`已標註的 ${pct(S.ok, S.labeled)}`} />
          <Kpi k="未標註" dot="var(--border)" v={S.unlabeled} s={pct(S.unlabeled, S.images)} />
          <Kpi k="框數" v={S.boxes} s={`每張 NG 平均 ${S.ng ? S.avg_boxes_per_ng.toFixed(2) : '—'} 個`} />
        </div>
        <div style={{ marginTop: 14 }}>
          <ProgressBar ng={S.ng} ok={S.ok} total={S.images} />
        </div>
      </section>

      <section className="panel">
        <div className="sec-head">
          <h2>各類別分布</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="hint">點類別看框過該缺點的圖</span>
            <div className="seg">
              {(['boxes', 'images'] as By[]).map((b) => (
                <button
                  key={b}
                  className={by === b ? 'on' : ''}
                  onClick={() => setParams(b === 'images' ? { by: 'images' } : {}, { replace: true })}
                >
                  {b === 'boxes' ? '框數' : '圖片數'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <Distribution data={S} by={by} />
      </section>
    </div>
  );
}

function Kpi({ k, v, s, dot }: { k: string; v: number; s: string; dot?: string }) {
  return (
    <div className="kpi">
      <div className="k">
        {dot && <i className="dot" style={{ background: dot }} />}
        {k}
      </div>
      <div className="v num">{fmt(v)}</div>
      <div className="s">{s}</div>
    </div>
  );
}

function Distribution({ data, by }: { data: StatsData; by: By }) {
  const classes = useSession((s) => s.classes);
  const navigate = useNavigate();
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const rows = data.classes
    .map((r) => ({ ...r, c: classes[r.class_id] }))
    .filter((r) => r.c)
    .sort((a, b) => b[by] - a[by] || a.class_id - b.class_id);
  const ticks = niceTicks(Math.max(0, ...rows.map((r) => r[by])));
  const top = ticks[ticks.length - 1] || 1;
  const x = (v: number) => `${(v / top) * 100}%`;

  return (
    <div
      onMouseLeave={() => setTip(null)}
      onMouseMove={(e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
        setTip(el ? { text: el.dataset.tip!, x: e.clientX, y: e.clientY } : null);
      }}
    >
      <div className="axis">
        <span />
        <div className="ticks">
          {ticks.map((v) => (
            <span key={v} style={{ left: x(v) }}>
              {fmt(v)}
            </span>
          ))}
        </div>
        <span />
      </div>
      <div className="dist">
        {rows.map((r) => (
          <div
            key={r.class_id}
            className={`dist-row ${r.images ? '' : 'zero'}`}
            data-tip={`${r.c.display}（${r.c.name}）：${fmt(r.boxes)} 個框、${fmt(r.images)} 張圖`}
            onClick={() => r.images && navigate(`/classes/${r.class_id}/images`)}
          >
            <span className="cname">
              <span className="sw" style={{ background: r.c.color }} />
              <span className="dn">{r.c.display}</span>
              <span className="en mono">{r.c.name}</span>
              {!r.c.active && <span className="badge b-gray">停用</span>}
            </span>
            <span className="track">
              <span className="fill" style={{ width: x(r[by]) }} />
              <span className="val" style={{ left: `calc(${x(r[by])} + 6px)` }}>
                {fmt(r[by])}
              </span>
            </span>
            <span className="imgs">
              {r.images ? (
                <Link
                  to={`/classes/${r.class_id}/images`}
                  title={`列出全部 Lot 中框過「${r.c.display}」的圖`}
                  onClick={(e) => e.stopPropagation()}
                >
                  看 {fmt(r.images)} 張 →
                </Link>
              ) : (
                <span className="none">沒有圖片</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        依{by === 'boxes' ? '框數' : '圖片數'}排序，單位：{by === 'boxes' ? '個框' : '張'}
        ；滑鼠移到類別上可看框數與圖片數；點類別或「看 N 張」會列出全部 Lot 中框過該缺點的圖
      </div>
      {tip && <ChartTip {...tip} />}
    </div>
  );
}

function ChartTip({ text, x, y }: { text: string; x: number; y: number }) {
  const left = Math.min(x + 12, window.innerWidth - 320);
  return (
    <div className="tip" style={{ display: 'block', left, top: Math.max(8, y - 40) }}>
      {text}
    </div>
  );
}
