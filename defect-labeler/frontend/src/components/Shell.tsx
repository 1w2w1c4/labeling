import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useDialog, useSession, useToast } from '../store/session';

function readTheme(): string | null {
  try {
    return localStorage.getItem('dl_theme');
  } catch {
    return null;
  }
}

/** 頂部列：品牌、標題 Labelme、深淺色切換、目前使用者（都不可點，除了品牌回主頁）。 */
export function Header() {
  const me = useSession((s) => s.me);
  const [theme, setTheme] = useState<string | null>(readTheme);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('dl_theme', next);
    } catch {
      /* 無痕模式等情況存不了，不影響使用 */
    }
    setTheme(next);
  };

  return (
    <header className="app">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Link className="brand" to="/">
          <div className="brand-mark" />
          Defect Labeler
        </Link>
        <span className="project-title">Labelme</span>
      </div>
      <div className="user">
        <button className="icon-btn" onClick={toggle} title="切換深淺色">
          ◐
        </button>
        {me ? (
          <>
            <span className="uname">{me.name}</span>
            <span className="avatar">{me.name.slice(0, 1).toUpperCase()}</span>
          </>
        ) : (
          <>
            <span className="uname">無權限</span>
            <span className="avatar">?</span>
          </>
        )}
      </div>
    </header>
  );
}

export function Toast() {
  const { text, shown } = useToast();
  return <div className={`toast ${shown ? 'show' : ''}`}>{text}</div>;
}

export function Dialog() {
  const { open, title, message, buttons, close } = useDialog();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  if (!open) return null;
  return (
    <div className="backdrop show" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="modal dialog" role="dialog" aria-modal="true">
        <h4>{title}</h4>
        <p>{message}</p>
        <div className="foot">
          {buttons.map((b) => (
            <button
              key={b.label}
              className={`btn ${b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-danger-ghost' : 'btn-ghost'}`}
              onClick={() => {
                close();
                b.onClick?.();
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Spinner({ dark = false }: { dark?: boolean }) {
  return <span className={`spinner ${dark ? 'dark' : ''}`} />;
}

export function EmptyPanel({ children }: { children: React.ReactNode }) {
  return <div className="panel empty">{children}</div>;
}

export function ProgressBar({ ng, ok, total }: { ng: number; ok: number; total: number }) {
  const w = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div className="progress">
      <div style={{ width: w(ng), background: 'var(--danger)' }} />
      <div style={{ width: w(ok), background: 'var(--ok)' }} />
    </div>
  );
}
