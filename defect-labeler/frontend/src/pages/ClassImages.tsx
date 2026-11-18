import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../api/client';
import type { ListItem, Stats } from '../api/types';
import { Combo } from '../components/Combo';
import { GridTools, ImageGrid, readDensity, type Density } from '../components/ImageGrid';
import { EmptyPanel } from '../components/Shell';
import { fmt, VERDICT, verdictKey } from '../lib/format';
import { useSession } from '../store/session';

/** 類別圖片清單：跨全部已開啟的 Lot，列出框過該類別的圖（不顯示 Lot）。 */
export default function ClassImages() {
  const { id = '' } = useParams();
  const classes = useSession((s) => s.classes);
  const navigate = useNavigate();
  const cls = /^\d+$/.test(id) ? classes[Number(id)] : undefined;
  const [total, setTotal] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [density, setDensity] = useState<Density>(readDensity);

  useEffect(() => {
    if (cls) document.title = `${cls.display} · 類別圖片清單`;
  }, [cls]);
  useEffect(() => {
    api.stats().then(setStats, () => setStats(null)); // 只用來顯示切換類別時的張數
  }, []);

  const fetchPage = useCallback(
    (cursor: string | null, limit: number) => api.classImages(Number(id), cursor, limit),
    [id],
  );

  const crumb = (
    <nav className="crumb">
      <Link to="/">主頁</Link> › <Link to="/stats">缺點分布統計</Link> › 類別圖片清單
    </nav>
  );
  if (!cls)
    return (
      <div className="page">
        {crumb}
        <EmptyPanel>
          <div style={{ fontSize: 16, color: 'var(--text)' }}>找不到這個缺點類別。</div>
          <Link className="btn btn-primary" to="/stats">
            回缺點分布統計
          </Link>
        </EmptyPanel>
      </div>
    );

  const counts = new Map(stats?.classes.map((c) => [c.class_id, c.images]) ?? []);
  const open = (it: ListItem) => {
    const box = it.defects.find((d) => d.class_id === cls.id);
    const q = new URLSearchParams({ from: 'class', class_id: String(cls.id) });
    if (box) q.set('box', box.id);
    navigate(`/lots/${encodeURIComponent(it.lot)}/a/${it.id}?${q}`);
  };

  return (
    <div className="page">
      {crumb}
      <section className="panel head">
        <div>
          <div className="title">
            <span className="sw" style={{ background: cls.color }} />
            <h1>{cls.display}</h1>
            <span className="en mono">
              {cls.name} · {cls.id}
            </span>
            {!cls.active && <span className="badge b-gray">停用</span>}
          </div>
          <div className="sub">
            框過「{cls.display}」的所有圖：<b>{total == null ? '…' : fmt(total)}</b> 張
          </div>
        </div>
        <div className="switch-cls">
          <Combo
            placeholder="切換到其他類別…"
            items={classes.map((c) => ({
              v: String(c.id),
              label: c.display,
              sub: c.name,
              color: c.color,
              count: counts.get(c.id),
              inactive: !c.active,
            }))}
            onPick={(v) => navigate(`/classes/${v}/images`)}
          />
        </div>
      </section>

      <div className="toolbar">
        <div>
          共 <b>{total == null ? '…' : fmt(total)}</b> 張 <span className="muted">· 框只標出「{cls.display}」，其他類別的框變淡</span>
        </div>
        <GridTools showBoxes={showBoxes} setShowBoxes={setShowBoxes} density={density} setDensity={setDensity} />
      </div>

      <ImageGrid
        resetKey={id}
        fetchPage={fetchPage}
        onTotal={setTotal}
        onOpen={open}
        highlightClass={cls.id}
        showBoxes={showBoxes}
        density={density}
        empty={
          <EmptyPanel>
            目前沒有任何圖框過「{cls.display}」
            <br />
            <Link className="btn btn-ghost" to="/stats">
              回缺點分布統計
            </Link>
          </EmptyPanel>
        }
        renderInfo={(it) => {
          const v = VERDICT[verdictKey(it.verdict)];
          return (
            <>
              <div className="r1">
                <span className="fn mono">{it.filename}</span>
                <span className="nbx">
                  {it.class_boxes ?? 0} 個{cls.display}
                </span>
              </div>
              <div className="r2 plain">
                <span className={`badge ${v.cls}`}>{v.label}</span>
                <span>共 {it.defect_count} 框</span>
              </div>
            </>
          );
        }}
      />
    </div>
  );
}
