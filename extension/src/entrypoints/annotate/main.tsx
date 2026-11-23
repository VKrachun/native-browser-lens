import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './Editor';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';
import { AppStatus } from '@/ui/AppStatus';

followSystemTheme();

/** When the app answers again, the editor loads a capture it could not load; marks on screen stay. */
function Page() {
  const [back, setBack] = useState(0);
  return (
    <>
      <AppStatus onBack={() => setBack((n) => n + 1)} />
      <Editor capture={Number(new URLSearchParams(location.search).get('capture'))} back={back} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
