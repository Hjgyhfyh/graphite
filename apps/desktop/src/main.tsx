import '@fontsource-variable/inter/index.css';
import '@fontsource/jetbrains-mono/index.css';
import '@fontsource/jetbrains-mono/500.css';
import '@graphite/ui/src/tokens.css';
import './index.css';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, CaptureApp, NoteApp } from './App';
import { useUiStore } from './stores/uiStore';
import { applyTheme } from './theme';

// Тема из persist-стора — синхронно, до первого рендера: без вспышки базовой
// палитры. Общий localStorage покрывает все окна (App/Capture/Note).
applyTheme(useUiStore.getState().theme);

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container "#root" is missing in index.html');
}

function pickWindow(): ReactNode {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('window');
  if (kind === 'capture') {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return <CaptureApp />;
  }
  if (kind === 'note') {
    const injected = (window as Window & { __GRAPHITE_NOTE_REF__?: unknown }).__GRAPHITE_NOTE_REF__;
    const initial = typeof injected === 'string' ? injected : (params.get('ref') ?? '');
    return <NoteApp initialRef={initial} />;
  }
  return <App />;
}

createRoot(container).render(<StrictMode>{pickWindow()}</StrictMode>);
