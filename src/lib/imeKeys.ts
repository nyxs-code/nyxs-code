/** A key press, from React (the composing flag on `nativeEvent`) or from the DOM. */
interface KeyLike {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

/** Whether a key press belongs to an input method's composition (Japanese, Chinese, Korean…):
 *  its Enter picks a candidate and must not send or submit. WebKit reports the Enter that ends
 *  a composition with keyCode 229 after isComposing is already false. */
export function isComposingKey(e: KeyLike): boolean {
  return Boolean(e.isComposing ?? e.nativeEvent?.isComposing) || e.keyCode === 229;
}
