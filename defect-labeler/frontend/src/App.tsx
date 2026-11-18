import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Link, Outlet, Route, Routes, useLocation } from 'react-router';
import { Dialog, EmptyPanel, Header, Spinner, Toast } from './components/Shell';
import ClassImages from './pages/ClassImages';
import Home from './pages/Home';
import LotView from './pages/LotView';
import Stats from './pages/Stats';
import { useSession } from './store/session';

// 標註頁（含 Konva 畫布）比較大，用到才載入
const Annotate = lazy(() => import('./pages/Annotate'));

function Layout() {
  const { status, error, load } = useSession();
  const { pathname } = useLocation();
  const fullHeight = pathname.includes('/a/'); // 標註頁佔滿整個視窗

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.body.classList.toggle('full', fullHeight);
  }, [fullHeight]);

  return (
    <>
      <Header />
      {status === 'loading' ? (
        <div className="more" style={{ paddingTop: 80 }}>
          <Spinner dark />
          載入中…
        </div>
      ) : status === 'error' ? (
        <div className="page">
          <EmptyPanel>
            <div style={{ fontSize: 16, color: 'var(--text)' }}>{error}</div>
            <button className="btn btn-primary" onClick={() => void load()}>
              重試
            </button>
          </EmptyPanel>
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="more" style={{ paddingTop: 80 }}>
              <Spinner dark />
              載入中…
            </div>
          }
        >
          <Outlet />
        </Suspense>
      )}
      <Toast />
      <Dialog />
    </>
  );
}

function NotFound() {
  return (
    <div className="page">
      <EmptyPanel>
        <div style={{ fontSize: 16, color: 'var(--text)' }}>找不到這個頁面</div>
        <Link className="btn btn-primary" to="/">
          回主頁
        </Link>
      </EmptyPanel>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="lots/:lot" element={<LotView />} />
          <Route path="lots/:lot/a/:annId" element={<Annotate />} />
          <Route path="stats" element={<Stats />} />
          <Route path="classes/:id/images" element={<ClassImages />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
