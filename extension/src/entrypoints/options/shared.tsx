import { useEffect } from 'react';
import { AlertIcon } from '@/ui/icons';

export function Problem({ text }: { text: string }) {
  return (
    <div role="alert" className="notice">
      <AlertIcon size={16} />
      <span>{text}</span>
    </div>
  );
}

/** Loads now and again when the window comes back: the person may change things elsewhere meanwhile. */
export function useLoadOnFocus(load: () => unknown) {
  useEffect(() => {
    void load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}
