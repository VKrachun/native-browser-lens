import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor } from './Editor';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';
import { AppStatus } from '@/ui/AppStatus';

followSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStatus onBack={() => {}} />
    <Editor capture={Number(new URLSearchParams(location.search).get('capture'))} />
  </StrictMode>,
);
