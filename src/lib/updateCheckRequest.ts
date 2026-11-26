/** Fired when Help › Check for updates asks Settings › About to look for one. */
export const UPDATE_CHECK_EVENT = "nyxs:about-check-updates";

let wanted = false;

/** Help › Check for updates: About looks for one as soon as it's on screen (or now, if it is). */
export function requestUpdateCheck(): void {
  wanted = true;
  window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
}

/** Whether a check was asked for and not yet made; the answer is given once. */
export function takeUpdateCheckRequest(): boolean {
  const was = wanted;
  wanted = false;
  return was;
}
