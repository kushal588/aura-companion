import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('AURA could not find its root element.');
}

/**
 * StrictMode stays on: it surfaces accidental double-subscription in the audio
 * and render layers during development, which is exactly the class of bug that
 * causes double-spoken replies or leaking WebGL contexts.
 */
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
