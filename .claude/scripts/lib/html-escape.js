'use strict';

/**
 * Shared HTML escaper for the report generators (dashboard + build report).
 *
 * Escapes the five characters that can break out of HTML text or an attribute
 * value, so no story title, epic name, or other data-derived string can inject
 * markup into a generated page. Kept in one place so a fix (e.g. escaping an
 * extra character) covers every generator instead of drifting between copies.
 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { esc };
