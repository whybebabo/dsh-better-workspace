/**
 * Keyboard-event helpers shared by the panel's inputs and global Escape handling.
 *
 * Input methods commit a composition with Enter and cancel it with Escape. Browsers still
 * deliver those keys to `keydown` while `event.isComposing` is true (older engines report
 * `keyCode === 229`), so a submit/close handler that only looks at `key` fires while the user
 * is still choosing candidates. This is the single predicate every such handler must consult.
 */

/**
 * @param {KeyboardEvent|React.KeyboardEvent|{isComposing?: boolean, keyCode?: number, nativeEvent?: {isComposing?: boolean, keyCode?: number}}|null|undefined} event
 * @returns {boolean} true while an IME composition owns the key event
 */
export function isComposing(event) {
  if (!event) return false;
  return event.isComposing === true
    || event.nativeEvent?.isComposing === true
    || event.keyCode === 229
    || event.nativeEvent?.keyCode === 229;
}