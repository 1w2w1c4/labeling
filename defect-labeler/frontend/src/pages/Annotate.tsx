import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError } from '../api/client';
import type { Annotation, BBox, Defect, DefectClass, Neighbors } from '../api/types';
import { AnnotCanvas } from '../components/AnnotCanvas';
import { Combo } from '../components/Combo';
import { EmptyPanel, Spinner } from '../components/Shell';
import { useEditLock } from '../hooks/useEditLock';
import { AI_CMP, aiLabel, computeAiCmp, FILTER_KEYS, fmt, fmtTime, hasFilters, readFilters } from '../lib/format';
import { showDialog, toast, useSession } from '../store/session';

/* ================= 編輯狀態（復原／重做） ================= */

interface EdState {
  defects: Defect[];
  sel: string | null;
  undo: Defect[][];
  redo: Defect[][];
  before: Defect[] | null; // 拖曳開始前的狀態（結束時才記一次復原點）
}

type EdAction =
  | { t: 'reset'; defects: Defect[] }
  | { t: 'set'; defects: Defect[]; sel?: string | null }
  | { t: 'select'; id: string | null }
  | { t: 'begin' }
  | { t: 'live'; id: string; bbox: BBox }
  | { t: 'end' }
  | { t: 'undo' }
  | { t: 'redo' };

const MAX_UNDO = 100;
const same = (a: Defect[], b: Defect[]) => JSON.stringify(a) === JSON.stringify(b);

function reducer(s: EdState, a: EdAction): EdState {
  switch (a.t) {
    case 'reset':
      return { defects: a.defects, sel: null, undo: [], redo: [], before: null };
    case 'set': {
      if (same(s.defects, a.defects)) return a.sel === undefined ? s : { ...s, sel: a.sel };
      const sel = a.sel === undefined ? s.sel : a.sel;
      return {
        ...s,
        defects: a.defects,
        sel: a.defects.some((d) => d.id === sel) ? sel : null,
        undo: [...s.undo, s.defects].slice(-MAX_UNDO),
        redo: [],
      };
    }
    case 'select':
      return { ...s, sel: a.id };
    case 'begin':
      return { ...s, before: s.defects };
    case 'live':
      return { ...s, defects: s.defects.map((d) => (d.id === a.id ? { ...d, bbox: a.bbox } : d)) };
    case 'end':
      if (!s.before || same(s.before, s.defects)) return { ...s, before: null };
      return { ...s, undo: [...s.undo, s.before].slice(-MAX_UNDO), redo: [], before: null };
    case 'undo': {
      if (!s.undo.length) return s;
      const prev = s.undo[s.undo.length - 1];
      return {
        ...s,
        defects: prev,
        undo: s.undo.slice(0, -1),
        redo: [...s.redo, s.defects],
        sel: prev.some((d) => d.id === s.sel) ? s.sel : null,
      };
    }
    case 'redo': {
      if (!s.redo.length) return s;
      const next = s.redo[s.redo.length - 1];
      return {
        ...s,
        defects: next,
        redo: s.redo.slice(0, -1),
        undo: [...s.undo, s.defects],
        sel: next.some((d) => d.id === s.sel) ? s.sel : null,
      };
    }
  }
}

/* ================= 最近使用的類別（快捷鍵 1–8） ================= */

function readRecent(classes: DefectClass[]): number[] {
  let ids: number[] = [];
  try {
    ids = JSON.parse(localStorage.getItem('dl_recent_cls') || '[]');
  } catch {
    ids = [];
  }
  ids = ids.filter((id) => classes[id]?.active);
  if (!ids.length) ids = classes.filter((c) => c.active).slice(0, 6).map((c) => c.id);
  return ids.slice(0, 8);
}
function saveRecent(ids: number[]) {
  try {
    localStorage.setItem('dl_recent_cls', JSON.stringify(ids));
  } catch {
    /* 存不了就算了 */
  }
}

const uid = () => `n${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
const clampBox = (b: BBox, W: number, H: number): BBox => {
  const w = Math.max(1, Math.min(W, Math.round(b.w)));
  const h = Math.max(1, Math.min(H, Math.round(b.h)));
  return { x: Math.max(0, Math.min(W - w, Math.round(b.x))), y: Math.max(0, Math.min(H - h, Math.round(b.y))), w, h };
};

/* ================= 頁面 ================= */

/** 路由：換圖時整個重新掛載（自動釋放上一張的鎖、清掉編輯狀態）。 */
export default function AnnotateRoute() {
  const { annId = '' } = useParams();
  return <Annotate key={annId} />;
}

function Annotate() {
  const { lot: rawLot = '', annId = '' } = useParams();
  const lot = rawLot.toUpperCase();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { classes, can } = useSession();
  const canAnnotate = can('annotate');

  const filters = useMemo(() => readFilters(params), [params]);
  const queue = params.get('queue') === '1';
  const fromClass = params.get('from') === 'class' && filters.class_id !== '';
  const boxParam = params.get('box');

  const [data, setData] = useState<Annotation | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [nb, setNb] = useState<Neighbors | null>(null);
  const [queueLeft, setQueueLeft] = useState<number | null>(null);
  const [ed, dispatch] = useReducer(reducer, { defects: [], sel: null, undo: [], redo: [], before: null });
  const [saved, setSaved] = useState<string>('[]');
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [recent, setRecent] = useState<number[]>(() => readRecent(classes));
  const [drawCls, setDrawCls] = useState<number>(() => readRecent(classes)[0] ?? 0);
  const [showBoxes, setShowBoxes] = useState(true);
  const [lostLock, setLostLock] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const lock = useEditLock(annId, canAnnotate);
  const blocked = lock.status === 'blocked' || lostLock !== null;
  const editable = canAnnotate && lock.status === 'held' && !lostLock;

  /* ---------- 載入 ---------- */

  useEffect(() => {
    api.annotation(annId).then(
      (a) => {
        if (a.lot !== lot) {
          setLoadErr(`這張圖屬於 Lot「${a.lot}」，不是「${lot}」`);
          return;
        }
        setData(a);
        dispatch({ t: 'reset', defects: a.defects });
        setSaved(JSON.stringify(a.defects));
        if (boxParam && a.defects.some((d) => d.id === boxParam)) dispatch({ t: 'select', id: boxParam });
        document.title = `${a.image.filename} · ${a.lot}`;
      },
      (e) => setLoadErr(e instanceof ApiError ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annId]);

  useEffect(() => {
    if (queue) {
      api.lot(lot).then(
        (i) => setQueueLeft(i.progress ? i.progress.total - i.progress.done : null),
        () => undefined,
      );
      return;
    }
    const mode = fromClass ? 'class' : 'lot';
    api.neighbors(annId, mode, fromClass ? { class_id: filters.class_id } : filters).then(setNb, () => setNb(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annId]);

  /* ---------- 導覽 ---------- */

  const dirty = data !== null && JSON.stringify(ed.defects) !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const listUrl = useMemo(() => {
    if (fromClass) return `/classes/${filters.class_id}/images`;
    const q = new URLSearchParams();
    if (!queue) for (const k of FILTER_KEYS) if (filters[k]) q.set(k, filters[k]);
    return `/lots/${encodeURIComponent(lot)}${q.toString() ? `?${q}` : ''}`;
  }, [fromClass, filters, queue, lot]);

  const urlFor = useCallback(
    (id: string, targetLot: string) => {
      const q = new URLSearchParams(params);
      q.delete('box');
      return `/lots/${encodeURIComponent(targetLot)}/a/${id}?${q}`;
    },
    [params],
  );

  const guard = (go: () => void) => {
    if (!dirtyRef.current) return go();
    showDialog('有尚未儲存的修改', '要先儲存再離開這張圖嗎？', [
      { label: '取消' },
      {
        label: '不儲存',
        kind: 'danger',
        onClick: () => {
          dirtyRef.current = false;
          go();
        },
      },
      { label: '儲存後前往', kind: 'primary', onClick: () => void save().then((ok) => ok && go()) },
    ]);
  };

  const goQueueNext = async () => {
    try {
      const q = await api.queueNext(lot, annId);
      if (!q.id) {
        toast('這個 Lot 已經沒有待標註的圖');
        navigate(listUrl);
        return;
      }
      navigate(`/lots/${encodeURIComponent(lot)}/a/${q.id}?queue=1`, { replace: true });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const hasNext = queue ? true : !!nb?.next;
  const hasPrev = queue ? false : !!nb?.prev;
  const goNext = () => {
    if (queue) return guard(() => void goQueueNext());
    if (nb?.next) guard(() => navigate(urlFor(nb.next!, nb.next_lot ?? lot)));
  };
  const goPrev = () => {
    if (nb?.prev) guard(() => navigate(urlFor(nb.prev!, nb.prev_lot ?? lot)));
  };
  const goList = () => guard(() => navigate(listUrl));

  /* ---------- 儲存（樂觀鎖：帶 version） ---------- */

  const save = async (): Promise<boolean> => {
    if (!data || !editable || saving) return false;
    if (!dirty && data.verdict !== null) {
      toast('沒有需要儲存的修改');
      return true;
    }
    setSaving(true);
    try {
      const a = await api.save(data.id, {
        version: data.version,
        defects: ed.defects.map((d) => ({ id: d.id, class_id: d.class_id, bbox: d.bbox, attributes: d.attributes ?? {} })),
      });
      setData(a);
      // 後端可能修正了框（裁切到圖內、補 id），以後端結果為準，但保留復原紀錄
      dispatch({ t: 'set', defects: a.defects });
      setSaved(JSON.stringify(a.defects));
      dirtyRef.current = false;
      toast(`已儲存 · 判定 ${a.verdict}${a.defect_count ? ` · ${a.defect_count} 框` : ''}`);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const current = e.body.current as Annotation | undefined;
        showDialog(
          '這張圖已經被別人修改過',
          `${current?.updated_by?.name ?? '其他人'} 在 ${fmtTime(current?.updated_at)} 儲存過。要載入最新內容（會捨棄你的修改）嗎？`,
          [
            { label: '取消' },
            {
              label: '載入最新內容',
              kind: 'primary',
              onClick: () => {
                if (!current) return;
                setData(current);
                dispatch({ t: 'reset', defects: current.defects });
                setSaved(JSON.stringify(current.defects));
              },
            },
          ],
        );
      } else if (e instanceof ApiError && e.status === 423) {
        setLostLock(((e.body.holder as { name?: string }) ?? {}).name ?? '其他人');
      } else {
        toast(e instanceof Error ? e.message : String(e));
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveAndNext = async () => {
    if (await save()) {
      if (queue) void goQueueNext();
      else if (nb?.next) navigate(urlFor(nb.next, nb.next_lot ?? lot));
      else toast('已經是最後一張');
    }
  };

  const revert = () =>
    showDialog('還原修改？', '會回到上次儲存的內容，尚未儲存的修改會遺失。', [
      { label: '取消' },
      { label: '還原', kind: 'danger', onClick: () => dispatch({ t: 'reset', defects: JSON.parse(saved) }) },
    ]);

  /* ---------- 編輯 ---------- */

  const W = data?.image.width || 300;
  const H = data?.image.height || 300;
  const sel = ed.defects.find((d) => d.id === ed.sel) ?? null;
  const activeClasses = useMemo(() => classes.filter((c) => c.active), [classes]);

  const pickClass = (id: number) => {
    const next = [id, ...recent.filter((x) => x !== id)].slice(0, 8);
    setRecent(next);
    saveRecent(next);
    if (sel && editable) {
      dispatch({ t: 'set', defects: ed.defects.map((d) => (d.id === sel.id ? { ...d, class_id: id, class_name: classes[id]?.name } : d)) });
    } else setDrawCls(id);
  };
  const updateSel = (patch: Partial<BBox>) => {
    if (!sel || !editable) return;
    const b = clampBox({ ...sel.bbox, ...patch }, W, H);
    dispatch({ t: 'set', defects: ed.defects.map((d) => (d.id === sel.id ? { ...d, bbox: b } : d)) });
  };
  const removeDefect = (id: string) => {
    if (!editable) return;
    dispatch({ t: 'set', defects: ed.defects.filter((d) => d.id !== id) });
  };

  /* ---------- 快捷鍵 ---------- */

  const keyState = useRef({ ed, sel, editable, recent, pickClass, save, saveAndNext, goNext, goPrev, updateSel, removeDefect });
  keyState.current = { ed, sel, editable, recent, pickClass, save, saveAndNext, goNext, goPrev, updateSel, removeDefect };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.backdrop.show')) return; // 對話框開著
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = keyState.current;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') {
        e.preventDefault();
        void k.save();
        return;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        void k.saveAndNext();
        return;
      }
      if (mod && key === 'z') {
        e.preventDefault();
        dispatch({ t: e.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        dispatch({ t: 'redo' });
        return;
      }
      if (mod) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (/^[1-8]$/.test(e.key) && k.recent[Number(e.key) - 1] != null) {
        k.pickClass(k.recent[Number(e.key) - 1]);
        return;
      }
      if (k.sel && k.editable && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const st = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0;
        const dy = e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0;
        k.updateSel({ x: k.sel.bbox.x + dx, y: k.sel.bbox.y + dy });
        return;
      }
      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (k.sel) k.removeDefect(k.sel.id);
          break;
        case 'Tab': {
          e.preventDefault();
          const list = k.ed.defects;
          if (!list.length) break;
          const i = list.findIndex((d) => d.id === k.ed.sel);
          const n = list.length;
          dispatch({ t: 'select', id: list[((i < 0 ? -1 : i) + (e.shiftKey ? n - 1 : 1)) % n].id });
          break;
        }
        case 'Escape':
          if (k.ed.sel) dispatch({ t: 'select', id: null });
          break;
        case 'a':
        case 'A':
        case 'ArrowLeft':
          k.goPrev();
          break;
        case 'd':
        case 'D':
        case 'ArrowRight':
          k.goNext();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------- 畫面 ---------- */

  if (loadErr)
    return (
      <div className="page">
        <EmptyPanel>
          <div style={{ fontSize: 16, color: 'var(--text)', marginBottom: 12 }}>{loadErr}</div>
          <Link className="btn btn-primary" to={listUrl}>
            回清單
          </Link>
        </EmptyPanel>
      </div>
    );
  if (!data)
    return (
      <div className="page">
        <div className="more">
          <Spinner dark />
          載入中…
        </div>
      </div>
    );

  const curCls = classes[sel ? sel.class_id : drawCls] ?? activeClasses[0];
  const liveVerdict = ed.defects.length ? 'NG' : data.verdict === null && !dirty ? null : 'OK';
  const cmp = computeAiCmp(liveVerdict, data.ai, ed.defects.map((d) => d.class_id));
  const holderName = lostLock ?? lock.holder?.name ?? '其他人';
  const setLabel = queue
    ? `佇列剩 ${queueLeft == null ? '…' : fmt(queueLeft)} 張`
    : `${fromClass ? `${classes[Number(filters.class_id)]?.display ?? ''} ` : hasFilters(filters) ? '篩選結果 ' : '全部 '}${
        nb?.position != null ? fmt(nb.position) : '–'
      } / ${nb ? fmt(nb.total) : '…'}`;

  return (
    <div className="annotate">
      <div className="subbar">
        <a className="back" onClick={goList}>
          ← {queue ? 'Lot 清單' : '回清單'}
        </a>
        <span className="sep" />
        <span className="mono" style={{ color: 'var(--muted)', fontSize: 13 }}>
          {data.lot}
        </span>
        <span className="fname mono">{data.image.filename}</span>
        <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>#{fmt(data.seq)}</span>
        <span className="sep" />
        <div className="nav">
          <button className="btn btn-ghost" disabled={!hasPrev} onClick={goPrev} title="上一張（A）">
            ‹ 上一張
          </button>
          <span>{setLabel}</span>
          <button className="btn btn-ghost" disabled={!hasNext} onClick={goNext} title="下一張（D）">
            下一張 ›
          </button>
        </div>
        <span className="grow" />
        <div className="mode">
          {!canAnnotate ? (
            <span className="badge b-gray">唯讀（沒有框圖權限）</span>
          ) : blocked ? (
            <span className="badge b-orange">🔒 {holderName} 編輯中</span>
          ) : lock.status === 'pending' ? (
            <span className="lockinfo">
              <Spinner dark /> 取得編輯鎖…
            </span>
          ) : lock.status === 'error' ? (
            <span className="badge b-red" title={lock.error ?? ''}>
              無法取得編輯鎖
            </span>
          ) : (
            <>
              <span
                className="lockinfo"
                title={lock.degraded ? 'Redis 無法使用：沒有編輯鎖，儲存時仍會檢查版本' : '進入即取得編輯鎖，停留期間自動續約，離開時釋放'}
              >
                {lock.degraded ? '⚠ 無編輯鎖' : '🔒 編輯中'}
              </span>
              <button className="btn btn-ghost" disabled={!dirty} onClick={revert} title="還原到上次儲存">
                還原
              </button>
              <button className="btn btn-ghost" onClick={() => void save()} disabled={saving} title="Ctrl+S">
                {saving && <Spinner dark />}儲存
              </button>
              <button className="btn btn-primary" onClick={() => void saveAndNext()} disabled={saving || !hasNext} title="Ctrl+Enter">
                儲存並下一張
              </button>
            </>
          )}
        </div>
      </div>

      <div className="work">
        <div className="stage">
          <AnnotCanvas
            url={data.url}
            width={W}
            height={H}
            defects={ed.defects}
            classes={classes}
            selected={ed.sel}
            drawClass={classes[drawCls]?.active ? classes[drawCls] : activeClasses[0]}
            editable={editable}
            showBoxes={showBoxes}
            onSelect={(id) => dispatch({ t: 'select', id })}
            onCreate={(bbox) => {
              const c = classes[drawCls]?.active ? classes[drawCls] : activeClasses[0];
              if (!c) return;
              const nd: Defect = { id: uid(), class_id: c.id, class_name: c.name, bbox, attributes: {} };
              dispatch({ t: 'set', defects: [...ed.defects, nd], sel: nd.id });
            }}
            onEdit={(phase, id, bbox) => {
              if (phase === 'begin') dispatch({ t: 'begin' });
              else if (phase === 'live' && bbox) dispatch({ t: 'live', id, bbox });
              else dispatch({ t: 'end' });
            }}
            onCursor={setCursor}
          />
          {blocked && (
            <div className="blocked show">
              <div className="box">
                <div style={{ fontWeight: 600 }}>🔒 {holderName} 正在編輯這張圖</div>
                <p>同一時間只能一個人編輯，請先處理其他圖片。</p>
                <div className="btns">
                  <a className="btn btn-ghost btn-sm" onClick={goList}>
                    回清單
                  </a>
                  {hasNext && (
                    <button className="btn btn-primary btn-sm" onClick={goNext}>
                      下一張
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="side">
          <section className="sec rec" title="以整張圖為單位，每次儲存覆寫為最後一次">
            <span className="lbl">最後修改</span>
            <span>
              {data.updated_by ? (
                <>
                  <b>{data.updated_by.name}</b>
                  <span className="t mono">{fmtTime(data.updated_at)}</span>
                </>
              ) : (
                <span className="none">尚未儲存（儲存時記錄）</span>
              )}
            </span>
            <span className="lbl">AI</span>
            <span title="AI 分類結果（來源資料帶入，不可修改）">
              <b>{aiLabel(data.ai, classes)}</b>
              {data.ai?.score != null && <span className="t mono">{Number(data.ai.score).toFixed(2)}</span>}
              {cmp && (
                <span
                  className="badge"
                  style={{ marginLeft: 8, background: 'transparent', border: `1px solid ${AI_CMP[cmp].color}`, color: AI_CMP[cmp].color }}
                  title={AI_CMP[cmp].tip}
                >
                  {AI_CMP[cmp].label}
                </span>
              )}
            </span>
          </section>

          <section className="sec">
            <h3>
              {sel ? `框 #${ed.defects.indexOf(sel) + 1} 的類別` : '新框類別'}
              <span className="x">按 / 搜尋 · 1–{recent.length} 最近使用</span>
            </h3>
            {curCls && (
              <div className="curcls">
                <span className="sw" style={{ background: curCls.color }} />
                <b>{curCls.display}</b>
                <span className="sub mono">
                  {curCls.name} · #{curCls.id}
                </span>
                {!curCls.active && <span className="sub">（停用）</span>}
              </div>
            )}
            {editable && (
              <Combo
                inputRef={searchRef}
                placeholder={sel ? '輸入名稱或代碼，變更此框類別…' : '輸入類別名稱或代碼搜尋…'}
                items={activeClasses.map((c) => ({ v: String(c.id), label: c.display, sub: c.name, color: c.color }))}
                recent={recent.map(String)}
                onPick={(v) => pickClass(Number(v))}
              />
            )}
            <div className="recent">
              {recent.map((id, i) => {
                const c = classes[id];
                if (!c) return null;
                return (
                  <button
                    key={id}
                    className={`rchip ${id === curCls?.id ? 'on' : ''}`}
                    disabled={!editable && !!sel}
                    title={c.name}
                    onClick={() => pickClass(id)}
                  >
                    <span className="sw" style={{ background: c.color }} />
                    {c.display}
                    <span className="k">{i + 1}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="sec">
            <h3>
              缺點清單（{ed.defects.length}）
              <span className="x">
                <label className="switch" style={{ marginRight: 8 }}>
                  <input type="checkbox" checked={showBoxes} onChange={(e) => setShowBoxes(e.target.checked)} />
                  顯示框
                </label>
                <span className="mono">x, y, w, h</span>
              </span>
            </h3>
            <div className="dlist">
              {ed.defects.length ? (
                ed.defects.map((d, i) => {
                  const c = classes[d.class_id];
                  const b = d.bbox;
                  return (
                    <div
                      key={d.id}
                      className={`drow ${d.id === ed.sel ? 'sel' : ''}`}
                      onClick={() => dispatch({ t: 'select', id: d.id })}
                    >
                      <span className="no">{i + 1}</span>
                      <span className="sw" style={{ background: c?.color ?? '#999' }} />
                      <span>
                        {c?.display ?? d.class_id}
                        {c && !c.active && <span style={{ color: 'var(--muted)', fontSize: 12 }}>（停用）</span>}
                      </span>
                      <span className="sz mono">
                        {b.x}, {b.y}, {b.w}, {b.h}
                      </span>
                      {editable && (
                        <button
                          className="ib"
                          title="刪除（Delete）"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeDefect(d.id);
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="empty-d">
                  {editable ? '在圖片上拖曳即可新增框。沒有缺點時直接儲存，會記為 OK。' : '沒有框。'}
                </div>
              )}
            </div>
          </section>

          {sel && (
            <section className="sec">
              <h3>
                選取框 #{ed.defects.indexOf(sel) + 1} <span className="x">像素座標</span>
              </h3>
              <div className="xywh">
                {(['x', 'y', 'w', 'h'] as const).map((k) => (
                  <div key={`${sel.id}-${k}-${sel.bbox[k]}`}>
                    <label>{k}</label>
                    <input
                      type="number"
                      className="mono"
                      defaultValue={sel.bbox[k]}
                      min={k === 'w' || k === 'h' ? 1 : 0}
                      max={k === 'x' || k === 'w' ? W : H}
                      disabled={!editable}
                      onBlur={(e) => Number(e.target.value) !== sel.bbox[k] && updateSel({ [k]: Number(e.target.value) || 0 })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          <details className="sec">
            <summary>圖片資訊</summary>
            <dl className="kv">
              <dt>路徑</dt>
              <dd className="mono">{data.image.path}</dd>
              <dt>尺寸</dt>
              <dd>
                {W} × {H}
              </dd>
              {Object.entries(data.meta).map(([k, v]) => (
                <MetaRow key={k} k={k} v={v} />
              ))}
              <dt>圖片 id</dt>
              <dd className="mono">{data.image_id}</dd>
              <dt>版本</dt>
              <dd>v{data.version}</dd>
            </dl>
          </details>
        </aside>
      </div>

      <div className="statusbar">
        <span>{cursor ? `x ${cursor.x}, y ${cursor.y}` : '—'}</span>
        <span>
          {W} × {H} px
        </span>
        <span>{data.updated_by ? `最後修改 ${data.updated_by.name} ${fmtTime(data.updated_at)}` : ''}</span>
        <span>{dirty ? <span className="dirty">● 尚未儲存</span> : data.verdict ? '已儲存' : '尚未標註'}</span>
        <span className="grow" />
        <span className="keys-hint">拖曳畫框 · 方向鍵微調（Shift ×10）· Tab 切換框 · Delete 刪除 · Ctrl+Z 復原</span>
      </div>
    </div>
  );
}

const META_LABEL: Record<string, string> = { product: '產品', station: '站點', captured_at: '拍攝' };

function MetaRow({ k, v }: { k: string; v: unknown }) {
  const text =
    v == null ? '—' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtTime(v) : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return (
    <>
      <dt>{META_LABEL[k] ?? k}</dt>
      <dd>{text}</dd>
    </>
  );
}
