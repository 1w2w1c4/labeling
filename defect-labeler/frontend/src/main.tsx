import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// 不使用 StrictMode：開發模式下它會讓 effect 執行兩次，編輯鎖會「取得 → 釋放 → 取得」，
// 釋放請求可能比第二次取得晚到，導致鎖被自己釋放掉。
createRoot(document.getElementById('root')!).render(<App />);
