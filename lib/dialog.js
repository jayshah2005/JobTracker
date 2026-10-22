/**
 * Small promise-based, accessible in-page dialogs that replace the native
 * confirm()/prompt()/alert() boxes (which look out of place in an extension and
 * cannot explain much). Styles live in lib/dialog.css, which each page loads.
 *
 * - choiceDialog({ title, message, choices, defaultChoice }) -> value | null
 * - confirmDialog({ title, message, confirmLabel, cancelLabel, danger }) -> boolean
 * - promptDialog({ title, message, label, defaultValue, confirmLabel, validate }) -> string | null
 *
 * Behaviour: role="dialog" + aria-modal, focus moves into the dialog and is
 * trapped with Tab, restored to the previously focused element on close, Esc
 * and backdrop click cancel. Text is always set via textContent (no HTML).
 */

let idCounter = 0;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Add message text; blank lines split paragraphs. */
function appendParagraphs(parent, message, className) {
  String(message || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((p) => parent.appendChild(el('p', className, p)));
}

/**
 * Core dialog builder. `build(body, api)` fills the body and returns optional
 * hooks. Resolves with whatever `api.close(value)` is called with; Esc and
 * backdrop clicks close with `cancelValue`.
 */
function openDialog({ title, message, build, buttons, cancelValue = null, initialFocus }) {
  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const id = `jt-dialog-${++idCounter}`;

    const backdrop = el('div', 'jt-dialog-backdrop');
    const box = el('div', 'jt-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', `${id}-title`);
    box.setAttribute('aria-describedby', `${id}-body`);

    box.appendChild(Object.assign(el('h2', 'jt-dialog-title', title), { id: `${id}-title` }));
    const body = el('div', 'jt-dialog-body');
    body.id = `${id}-body`;
    appendParagraphs(body, message, 'jt-dialog-text');
    box.appendChild(body);

    let closed = false;
    const api = {
      close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown, true);
        backdrop.remove();
        try {
          previouslyFocused?.focus?.();
        } catch {
          /* element may be gone */
        }
        resolve(value);
      },
    };

    const hooks = (build && build(body, api)) || {};
    const actions = el('div', 'jt-dialog-actions');
    const buttonEls = buttons(api, hooks).map(({ label, className, onClick, key }) => {
      const b = el('button', className, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return { key, node: b };
    });
    box.appendChild(actions);
    backdrop.appendChild(box);

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        api.close(cancelValue);
        return;
      }
      if (e.key === 'Tab') {
        const items = [...box.querySelectorAll(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (!box.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    // Only a click that starts AND ends on the backdrop cancels (so dragging a
    // text selection out of the input does not dismiss the dialog).
    let downOnBackdrop = false;
    backdrop.addEventListener('mousedown', (e) => {
      downOnBackdrop = e.target === backdrop;
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop && downOnBackdrop) api.close(cancelValue);
    });

    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(backdrop);

    const target =
      (typeof initialFocus === 'function' && initialFocus(hooks)) ||
      buttonEls.find((b) => b.key === initialFocus)?.node ||
      buttonEls[buttonEls.length - 1]?.node;
    target?.focus();
  });
}

const BTN = {
  primary: 'jt-dialog-btn jt-dialog-btn-primary',
  danger: 'jt-dialog-btn jt-dialog-btn-danger',
  secondary: 'jt-dialog-btn jt-dialog-btn-secondary',
};

/**
 * Show several labelled choices plus a Cancel button.
 * @param {object} o
 * @param {{value:string,label:string,variant?:'primary'|'danger'|'secondary'}[]} o.choices
 * @param {string} [o.defaultChoice] value of the choice to focus (default: Cancel)
 * @returns {Promise<string|null>} chosen value, or null if cancelled
 */
export function choiceDialog({
  title,
  message,
  choices,
  cancelLabel = 'Cancel',
  defaultChoice,
}) {
  return openDialog({
    title,
    message,
    initialFocus: defaultChoice ?? 'cancel',
    buttons: (api) => [
      ...choices.map((c) => ({
        key: c.value,
        label: c.label,
        className: BTN[c.variant || 'secondary'],
        onClick: () => api.close(c.value),
      })),
      {
        key: 'cancel',
        label: cancelLabel,
        className: BTN.secondary,
        onClick: () => api.close(null),
      },
    ],
  });
}

/**
 * Ask a yes/no question with verb-labelled buttons. Focus starts on Cancel
 * for `danger` dialogs and on the confirm button otherwise.
 * @returns {Promise<boolean>}
 */
export async function confirmDialog({
  title,
  message,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  const result = await choiceDialog({
    title,
    message,
    cancelLabel,
    choices: [{ value: 'yes', label: confirmLabel, variant: danger ? 'danger' : 'primary' }],
    defaultChoice: danger ? 'cancel' : 'yes',
  });
  return result === 'yes';
}

/**
 * Ask for a line of text. `validate(value)` returns an error string (shown
 * inline, dialog stays open) or a falsy value when the input is acceptable.
 * @returns {Promise<string|null>} trimmed value, or null if cancelled
 */
export function promptDialog({
  title,
  message,
  label,
  defaultValue = '',
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  validate = () => '',
}) {
  return openDialog({
    title,
    message,
    initialFocus: (h) => h.input,
    build(body, api) {
      const field = el('label', 'jt-dialog-field');
      field.appendChild(el('span', 'jt-dialog-label', label));
      const input = el('input', 'jt-dialog-input');
      input.type = 'text';
      input.value = defaultValue;
      input.autocomplete = 'off';
      const errorId = `jt-dialog-err-${++idCounter}`;
      const error = el('p', 'jt-dialog-error');
      error.id = errorId;
      error.setAttribute('role', 'alert');
      error.hidden = true;
      field.appendChild(input);
      body.appendChild(field);
      body.appendChild(error);

      const submit = () => {
        const value = input.value.trim();
        const problem = validate(value);
        if (problem) {
          error.textContent = problem;
          error.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', errorId);
          input.focus();
          return;
        }
        api.close(value);
      };
      input.addEventListener('input', () => {
        error.hidden = true;
        input.removeAttribute('aria-invalid');
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      setTimeout(() => input.select?.(), 0);
      return { input, submit };
    },
    buttons: (api, hooks) => [
      {
        key: 'confirm',
        label: confirmLabel,
        className: BTN.primary,
        onClick: () => hooks.submit(),
      },
      {
        key: 'cancel',
        label: cancelLabel,
        className: BTN.secondary,
        onClick: () => api.close(null),
      },
    ],
  });
}
