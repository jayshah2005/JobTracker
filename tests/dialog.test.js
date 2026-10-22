import { choiceDialog, confirmDialog, promptDialog } from '../lib/dialog.js';

const $ = (sel) => document.querySelector(sel);
const buttons = () => [...document.querySelectorAll('.jt-dialog-btn')];
const byLabel = (l) => buttons().find((b) => b.textContent === l);
const key = (k, opts = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('confirmDialog', () => {
  test('renders accessible dialog with verb labels and resolves true', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const p = confirmDialog({ title: 'T', message: 'a\n\nb', confirmLabel: 'Delete row', danger: true });
    const dlg = $('[role="dialog"]');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dlg.getAttribute('aria-labelledby')).textContent).toBe('T');
    expect(dlg.querySelectorAll('.jt-dialog-text')).toHaveLength(2);
    // danger dialogs focus Cancel first
    expect(document.activeElement.textContent).toBe('Cancel');
    byLabel('Delete row').click();
    await expect(p).resolves.toBe(true);
    expect($('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('Esc and backdrop click cancel', async () => {
    let p = confirmDialog({ title: 'T', message: 'm' });
    key('Escape');
    await expect(p).resolves.toBe(false);
    p = confirmDialog({ title: 'T', message: 'm' });
    const bd = $('.jt-dialog-backdrop');
    bd.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    bd.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(p).resolves.toBe(false);
  });

  test('Tab wraps focus inside the dialog', async () => {
    const p = confirmDialog({ title: 'T', message: 'm', confirmLabel: 'Go' });
    const [first, last] = [buttons()[0], buttons()[1]];
    last.focus();
    key('Tab');
    expect(document.activeElement).toBe(first);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    key('Escape');
    await p;
  });

  test('escapes HTML in messages', async () => {
    const p = confirmDialog({ title: 'T', message: '<img src=x onerror=1>' });
    expect($('.jt-dialog img')).toBeNull();
    key('Escape');
    await p;
  });
});

describe('choiceDialog', () => {
  test('returns chosen value, null on cancel, focuses default', async () => {
    const choices = [
      { value: 'hide', label: 'Hide from the form', variant: 'primary' },
      { value: 'delete', label: 'Delete column', variant: 'danger' },
    ];
    let p = choiceDialog({ title: 'T', message: 'm', choices, defaultChoice: 'hide' });
    expect(document.activeElement.textContent).toBe('Hide from the form');
    byLabel('Delete column').click();
    await expect(p).resolves.toBe('delete');
    p = choiceDialog({ title: 'T', message: 'm', choices });
    byLabel('Cancel').click();
    await expect(p).resolves.toBeNull();
  });
});

describe('promptDialog', () => {
  test('validates inline, then resolves trimmed value on Enter', async () => {
    const validate = (v) => (!v ? 'Please enter a name.' : v === 'dup' ? 'Taken.' : '');
    const p = promptDialog({ title: 'T', message: 'm', label: 'Name', defaultValue: '', validate });
    const input = $('.jt-dialog-input');
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect($('.jt-dialog-error').hidden).toBe(false);
    expect($('.jt-dialog-error').textContent).toBe('Please enter a name.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = 'dup';
    input.dispatchEvent(new Event('input'));
    expect($('.jt-dialog-error').hidden).toBe(true);
    byLabelClick('Save');
    expect($('.jt-dialog-error').textContent).toBe('Taken.');
    input.value = '  Notes  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(p).resolves.toBe('Notes');
  });

  test('Cancel resolves null', async () => {
    const p = promptDialog({ title: 'T', message: 'm', label: 'Name' });
    key('Escape');
    await expect(p).resolves.toBeNull();
  });
});

function byLabelClick(l) {
  byLabel(l).click();
}
