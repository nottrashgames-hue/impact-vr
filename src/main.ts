import './styles.css';
import { App } from './core/App';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');

App.create(container)
  .then((app) => {
    // Handy for poking at systems from the dev console.
    if (import.meta.env.DEV) Object.assign(window, { app });
  })
  .catch((err: unknown) => {
    console.error(err);
    const status = document.getElementById('xr-status');
    if (status) {
      status.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
      status.classList.add('error');
    }
  });
