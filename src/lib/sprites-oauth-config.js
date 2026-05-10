/**
 * sprites.dev OAuth configuration.
 *
 * IMPORTANT: The values below are PLACEHOLDERS. The sprites.dev OAuth
 * endpoint URLs and scope identifiers are not documented in this repo.
 * Replace each `__REPLACE_*__` value with the real URL/scope/clientId
 * before building the extension. The OAuth helper (sprites-oauth.js)
 * fail-fasts at runtime if any placeholder is still present.
 *
 * Required references for the operator filling this in:
 *   - sprites.dev OAuth 2.0 + PKCE authorization endpoint
 *   - Token endpoint
 *   - Refresh endpoint (if separate; otherwise reuse the token endpoint)
 *   - Scope strings for assignment-read and grade-read
 *   - Public client_id registered for this Chrome extension
 *
 * Redirect URI for chrome.identity.launchWebAuthFlow is computed at
 * runtime as `https://<extension-id>.chromiumapp.org/sprites` and must
 * be registered with sprites.dev as the allowed redirect URI for the
 * client_id below.
 */

export const SPRITES_OAUTH_CONFIG = Object.freeze({
  authorizationEndpoint: '__REPLACE_SPRITES_AUTHORIZATION_URL__',
  tokenEndpoint: '__REPLACE_SPRITES_TOKEN_URL__',
  refreshEndpoint: '__REPLACE_SPRITES_REFRESH_URL__',
  clientId: '__REPLACE_SPRITES_CLIENT_ID__',
  scopes: Object.freeze([
    '__REPLACE_SPRITES_SCOPE_ASSIGNMENT_READ__',
    '__REPLACE_SPRITES_SCOPE_GRADE_READ__',
  ]),
});

const PLACEHOLDER_PREFIX = '__REPLACE_';

/**
 * Throws if any config field still holds a placeholder. Called by
 * sprites-oauth.js before initiating any network request, so that an
 * un-configured build cannot accidentally hit a fabricated URL.
 * @returns {void}
 */
export function assertConfigured() {
  const c = SPRITES_OAUTH_CONFIG;
  const checks = [
    ['authorizationEndpoint', c.authorizationEndpoint],
    ['tokenEndpoint', c.tokenEndpoint],
    ['refreshEndpoint', c.refreshEndpoint],
    ['clientId', c.clientId],
    ...c.scopes.map((s, i) => [`scopes[${i}]`, s]),
  ];
  const unset = checks.filter(([, v]) => typeof v !== 'string' || v.startsWith(PLACEHOLDER_PREFIX));
  if (unset.length > 0) {
    const names = unset.map(([k]) => k).join(', ');
    throw new Error(
      `sprites-oauth-config.js has unset placeholders: ${names}. ` +
      `Fill in real sprites.dev values before invoking the OAuth flow.`
    );
  }
  for (const [name, value] of checks.slice(0, 3)) {
    if (!/^https:\/\//.test(value)) {
      throw new Error(`sprites-oauth-config.${name} must be an https:// URL, got: ${value}`);
    }
  }
}
