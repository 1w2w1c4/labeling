import { useEffect, useMemo, useRef, useState } from 'react';
import { fmt, matchScore } from '../lib/format';

export interface ComboItem {
  v: string;
  label: string;
  sub?: string;
  color?: string;
  count?: number;
  inactive?: boolean;
}

interface Props {
  items: ComboItem[];
  onPick: (v: string) => void;
  placeholder?: string;
  recent?: string[]; // 沒輸入時排在最前面，標示「最近使用」
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
}

function Hilite({ text, q }: { text: string; q: string }) {
  const s = q.trim();
  const i = s ? text.toLowerCase().indexOf(s.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + s.length)}</mark>
      {text.slice(i + s.length)}
    </>
  );
}

/** 類別很多（數十種以上）時的選擇方式：輸入搜尋 → 顯示建議清單點選，↑↓ 選擇、Enter 確定、Esc 取消。 */
export function Combo({ items, onPick, placeholder = '輸入搜尋…', recent, inputRef, className = '' }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [act, setAct] = useState(0);
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    if (!q.trim() && recent?.length) {
      const rec = recent.map((v) => items.find((x) => x.v === v)).filter((x): x is ComboItem => !!x);
      return [
        ...rec.map((x) => ({ ...x, recent: true })),
        ...items.filter((x) => !rec.includes(x)).map((x) => ({ ...x, recent: false })),
      ];
    }
    return items
      .map((x) => ({ x, s: matchScore(q, x.label, x.sub ?? '', x.v) }))
      .filter((o) => o.s > 0)
      .sort((a, b) => b.s - a.s || (b.x.count ?? 0) - (a.x.count ?? 0))
      .map((o) => ({ ...o.x, recent: false }));
  }, [items, q, recent]);

  const active = Math.min(act, Math.max(0, shown.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('.act')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (i: number) => {
    const it = shown[i];
    if (!it) return;
    setQ('');
    setOpen(false);
    ref.current?.blur();
    onPick(it.v);
  };

  return (
    <div className={`combo ${className}`}>
      <input
        ref={ref}
        className="combo-in"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={q}
        onFocus={() => {
          setAct(0);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQ(e.target.value);
          setAct(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          e.stopPropagation(); // 不觸發頁面快捷鍵
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setAct(Math.min(shown.length - 1, active + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setAct(Math.max(0, active - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(active);
          } else if (e.key === 'Escape') {
            setQ('');
            setOpen(false);
            ref.current?.blur();
          }
        }}
      />
      {open && (
        <div className="combo-list" ref={listRef}>
          {shown.length ? (
            shown.map((it, i) => (
              <div
                key={it.v}
                className={`combo-item ${i === active ? 'act' : ''} ${it.inactive ? 'inactive' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                onMouseMove={() => i !== active && setAct(i)}
              >
                {it.color && <span className="sw" style={{ background: it.color }} />}
                <span className="lb">
                  <Hilite text={it.label} q={q} />
                  {it.inactive && <span className="muted">（停用）</span>}
                </span>
                {it.sub && (
                  <span className="sub mono">
                    <Hilite text={it.sub} q={q} />
                  </span>
                )}
                {it.recent && (i === 0 || !shown[i - 1].recent) && <span className="tag">最近使用</span>}
                {it.count != null && <span className="cnt">{fmt(it.count)}</span>}
              </div>
            ))
          ) : (
            <div className="combo-empty">找不到「{q}」</div>
          )}
        </div>
      )}
    </div>
  );
}
