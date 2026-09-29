/** Validate the DTMF alphabet accepted by every voice-call transport. */
export function validateDtmfDigits(digits: string): string | null {
  return /^[0-9*#wWpP,]+$/.test(digits)
    ? null
    : "digits may only contain digits, *, #, comma, w, p";
}
