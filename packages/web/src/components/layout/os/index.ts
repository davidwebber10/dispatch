// The one entry of the OS shell chunk. Every lazy import of the OS shell goes through this file, so the
// OS parts form ONE chunk loaded only on a hosted workspace (or the business preview). Separate entries
// would share modules, and the build then moves shared code into the first-load "views" chunk.
import css from './os-shell.css?inline';

// The OS shell's styles travel with this chunk (the app has one first-load stylesheet; a local install
// must not pay for these). Injected once, when the chunk loads.
if (typeof document !== 'undefined' && !document.getElementById('os-shell-css')) {
  const el = document.createElement('style');
  el.id = 'os-shell-css';
  el.textContent = css;
  document.head.appendChild(el);
}

export { OsLeftRail } from './OsLeftRail';
export { OsTopBarActions } from './OsTopBarActions';
export { OsMobileMenu } from './OsMobileMenu';
