import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api/client';
import type { LotInfo } from '../api/types';
import { ProgressBar, Spinner } from '../components/Shell';
import { autoFormatLot, fmt, LOT_RE } from '../lib/format';
import { toast, useSession } from '../store/session';

const SOURCE_LABEL: Record<LotInfo['data_source'], string> = {
  redis: 'Redis 快取',
  mongo: 'MongoDB（背景回填快取中）',
  annotations: '已建立標註紀錄',
};

const POLL_MS = 1000;

export default function Home() {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<LotInfo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = LOT_RE.test(value);

  useEffect(() => {
    document.title = 'AVI Defect Labeler';
  }, []);

  const showErr = (msg: string) => {
    setError(msg);
    inputRef.current?.focus();
  };

  const lookup = async () => {
    const lot = value.trim().toUpperCase();
    if (!LOT_RE.test(lot)) {
      showErr(`「${lot || '（空白）'}」格式不正確，Lot 必須是 xxxxxx-xx-xx（6 碼-2 碼-2 碼英數字）。`);
      return;
    }
    setBusy(true);
    try {
      setInfo(await api.lot(lot));
    } catch (e) {
      showErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <h1>開始工作</h1>
      <p className="sub">輸入 Lot 編號開始標註，或先查看缺點分布統計再修正。</p>

      <div className="home-grid">
        <section className="card">
          <h2>
            <span className="step">1</span>輸入 Lot
          </h2>
          <p className="hint">系統會先查詢圖片數量，確認後才開啟。</p>
          <form
            className="lot-form"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup();
            }}
          >
            <input
              ref={inputRef}
              className={`lot-input mono ${valid ? 'valid' : ''} ${error ? 'err' : ''}`}
              placeholder="xxxxxx-xx-xx"
              maxLength={12}
              autoFocus
              value={value}
              onChange={(e) => {
                const ne = e.nativeEvent as InputEvent;
                setValue(ne.inputType?.startsWith('delete') ? e.target.value.toUpperCase() : autoFormatLot(e.target.value));
                setError('');
              }}
            />
            <button className="btn btn-primary" type="submit" disabled={!valid || busy}>
              {busy ? (
                <>
                  <Spinner />
                  查詢中
                </>
              ) : (
                '查詢'
              )}
            </button>
          </form>
          <div className={`fmt-hint ${valid ? 'ok' : ''}`}>
            {valid ? (
              '✓ 格式正確'
            ) : (
              <>
                格式：<span className="mono">xxxxxx-xx-xx</span>（英數字，輸入時自動補上 -）
              </>
            )}
          </div>
          {error && <div className="msg error show">{error}</div>}
        </section>

        <Link className="card stats-card" to="/stats">
          <h2>
            <span className="step">2</span>缺點分布統計
          </h2>
          <p className="hint" style={{ marginBottom: 4 }}>
            各缺點類別的框數與圖片數分布，點進類別可看框過該缺點的所有圖。
          </p>
          <div className="mini-bars" aria-hidden="true">
            {[92, 70, 52, 34, 22, 12].map((h) => (
              <span key={h} style={{ height: `${h}%` }} />
            ))}
          </div>
          <span className="go">查看統計 →</span>
        </Link>
      </div>

      {info && <LotModal info={info} onChange={setInfo} onClose={() => setInfo(null)} />}
    </main>
  );
}

function LotModal({
  info,
  onChange,
  onClose,
}: {
  info: LotInfo;
  onChange: (i: LotInfo) => void;
  onClose: () => void;
}) {
  const can = useSession((s) => s.can);
  const [opening, setOpening] = useState(false);
  const lot = info.lot;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 初始化中：輪詢進度
  useEffect(() => {
    if (info.status !== 'initializing') return;
    const t = setTimeout(async () => {
      try {
        onChange(await api.lot(lot));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [info, lot, onChange]);

  const open = async () => {
    if (!can('open_lot')) {
      toast('你沒有開啟 Lot 的權限（users.yaml）');
      return;
    }
    setOpening(true);
    try {
      onChange(await api.openLot(lot));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  const badge =
    info.status === 'open'
      ? { cls: 'b-green', text: '已開啟' }
      : info.status === 'initializing'
        ? { cls: 'b-blue', text: '開啟中' }
        : info.status === 'failed'
          ? { cls: 'b-red', text: '開啟失敗' }
          : { cls: 'b-orange', text: '尚未開啟' };
  const meta = info.meta as { product?: string; station?: string };
  const p = info.progress;
  const enc = encodeURIComponent(lot);

  return (
    <div className="backdrop show" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal lot-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Lot</div>
          <div>
            <span className="lot-name mono">{lot}</span>
            <span className={`badge ${badge.cls}`}>{badge.text}</span>
          </div>
        </div>
        <div className="modal-body">
          <dl className="kv">
            <dt>圖片數量</dt>
            <dd>
              <span className="big">{fmt(info.image_count)}</span> 張
            </dd>
            <dt>產品 / 站點</dt>
            <dd>
              {meta.product ?? '—'} · {meta.station ?? '—'}
            </dd>
            <dt>資料來源</dt>
            <dd>{SOURCE_LABEL[info.data_source]}</dd>
          </dl>

          {info.status === 'open' && p && (
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>標註進度</dt>
              <dd>
                {fmt(p.done)} / {fmt(p.total)}（{p.total ? ((p.done / p.total) * 100).toFixed(1) : 0}%）
                <div style={{ margin: '6px 0 4px' }}>
                  <ProgressBar ng={p.ng} ok={p.ok} total={p.total} />
                </div>
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
              </dd>
              <dt>線上人數</dt>
              <dd>{info.online} 人正在標註此 Lot</dd>
            </dl>
          )}

          {info.status === 'initializing' && info.init && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                初始化中… {fmt(info.init.done)} / {fmt(info.init.total)}
              </div>
              <div className="progress" style={{ marginTop: 6 }}>
                <div
                  style={{
                    width: `${info.init.total ? (info.init.done / info.init.total) * 100 : 0}%`,
                    background: 'var(--primary)',
                  }}
                />
              </div>
            </div>
          )}

          {(info.status === 'new' || info.status === 'failed') && (
            <div className="note">
              {info.status === 'failed' && (
                <div style={{ color: 'var(--danger)', marginBottom: 6 }}>{info.error ?? '上次開啟失敗'}</div>
              )}
              開啟後會為每張圖建立標註紀錄（每批 1,000 筆），{fmt(info.image_count)}{' '}
              張約需數秒。重複開啟不會產生重複資料，也不會覆蓋已經框好的結果。
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            {info.status === 'initializing' ? '關閉' : '取消'}
          </button>
          {info.status === 'open' ? (
            <>
              <Link className="btn btn-ghost" to={`/lots/${enc}`}>
                看圖片清單
              </Link>
              {can('annotate') && (
                <Link className="btn btn-primary" to={`/lots/${enc}?queue=1`}>
                  開始標註
                </Link>
              )}
            </>
          ) : info.status === 'initializing' ? (
            <button className="btn btn-primary" disabled>
              <Spinner />
              初始化中
            </button>
          ) : (
            can('open_lot') && (
              <button className="btn btn-primary" onClick={open} disabled={opening}>
                {opening && <Spinner />}
                {info.status === 'failed' ? '重新開啟' : '開啟 Lot'}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
