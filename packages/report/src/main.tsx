import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { loadFromDocument } from './data/load.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('report.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <App loaded={loadFromDocument(document)} />
  </StrictMode>,
);
