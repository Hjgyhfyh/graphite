import '@fontsource-variable/inter/index.css';
import '@fontsource/jetbrains-mono/index.css';
import '@fontsource/jetbrains-mono/500.css';
import '@graphite/ui/src/tokens.css';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Root container "#root" is missing in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
