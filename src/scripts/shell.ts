// The only script on every page (decision 70), and every page works without it: Ctrl/Cmd + K or
// "/" goes to search; Esc closes an open menu, the side panel or the phone menu; a click outside
// closes menus; in Approvals, J and K move to the next or previous update and Ctrl/Cmd + Enter
// approves the open one; notices (toasts) fade away; an open side panel takes the focus and keeps
// Tab inside it (decision 92); a form marked data-submit-once is sent once only (decision 94).
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const menus = () => document.querySelectorAll<HTMLDetailsElement>('details[data-menu][open]');
const go = (selector: string) => document.querySelector<HTMLAnchorElement>(selector)?.click();

document.addEventListener('keydown', (event) => {
  const search = document.getElementById('site-search') as HTMLInputElement | null;
  const command = event.metaKey || event.ctrlKey;
  if (search && ((command && event.key.toLowerCase() === 'k') || (event.key === '/' && !typing(event.target)))) {
    event.preventDefault();
    search.focus();
    search.select();
  } else if (event.key === 'Escape') {
    const open = menus();
    const close = document.querySelector<HTMLAnchorElement>('[data-panel-close]');
    if (open.length > 0) open.forEach((m) => m.removeAttribute('open'));
    else if (location.hash === '#menu') location.hash = '';
    else if (close && !typing(event.target)) location.href = close.href;
  } else if (command && event.key === 'Enter') {
    // Only on an approval page. Typing in a note sends that note's own form (so a return note
    // returns); otherwise it approves.
    const approve = document.querySelector<HTMLFormElement>('form[data-approve]');
    const own = typing(event.target) ? (event.target as HTMLElement).closest('form') : null;
    if (approve) {
      event.preventDefault();
      (own ?? approve).requestSubmit();
    }
  } else if (!command && !event.altKey && !typing(event.target) && (event.key === 'j' || event.key === 'k')) {
    go(event.key === 'j' ? '[data-key-next]' : '[data-key-prev]');
  }
});

// One menu open at a time; a click anywhere else closes it.
document.addEventListener('click', (event) => {
  for (const menu of menus()) if (!menu.contains(event.target as Node)) menu.removeAttribute('open');
});

for (const toast of document.querySelectorAll<HTMLElement>('[data-toast]')) {
  setTimeout(() => toast.classList.add('toast-gone'), 6000);
}

// Signing out also deletes unsent update drafts kept on this device (decision 91), for browsers
// that ignore the Clear-Site-Data header on the response.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form instanceof HTMLFormElement && new URL(form.action, location.href).pathname === '/auth/sign-out') {
    try {
      indexedDB.deleteDatabase('ggp-dashboard');
    } catch {
      // Storage blocked: nothing was kept.
    }
  }
});

// The side panel is a modal dialog (decision 92): focus moves to its title when it opens, and Tab
// and Shift + Tab cycle through its own links and buttons until it is closed (Esc or the cross).
const panel = document.querySelector<HTMLElement>('[data-testid="side-panel"]');
if (panel) {
  if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>('#panel-title')?.focus({ preventScroll: true });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const inside = panel.contains(document.activeElement);
    if (!inside || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  });
}

// A form marked data-submit-once is sent once: a second click or Enter while the next page loads
// does nothing (decision 94). The buttons are disabled after this tick, so the pressed button's
// own name and value still go with the form.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-submit-once')) return;
  if (form.dataset['sent'] === 'true') {
    event.preventDefault();
    return;
  }
  form.dataset['sent'] = 'true';
  form.setAttribute('aria-busy', 'true');
  setTimeout(() => form.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true)), 0);
});
