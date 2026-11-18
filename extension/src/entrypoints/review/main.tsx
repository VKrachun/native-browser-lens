import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Review } from './Review';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
import './style.css';
import { AppStatus } from '@/ui/AppStatus';

followSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStatus />
    <Review observation={Number(new URLSearchParams(location.search).get('observation'))} />
  </StrictMode>,
);
