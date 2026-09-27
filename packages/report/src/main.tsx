import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { readEmbedded, RESULTS_ELEMENT_ID } from './embedded.js';

const root = document.getElementById('root');
if (root === null) throw new Error('report.html has no #root element');

const embedded = readEmbedded(document.getElementById(RESULTS_ELEMENT_ID)?.textContent ?? null);
createRoot(root).render(
  <StrictMode>
    <App embedded={embedded} />
  </StrictMode>,
);
