// Moderation hook. server.js calls check() before every image request.
// To use your own moderation (an API, a classifier, another service), replace the body of check().
// Return { allowed: true } to continue, or { allowed: false, reason: 'message shown to the user' } to stop.
const BLOCKED = /\b(nude|nudes|naked|nsfw|porn\w*|sex|sexual|sexually|sexy|erotic\w*|explicit|hentai|fetish|topless|genitals?|gore|gory|dismember\w*|beheading|child abuse|loli\w*|underage)\b/i;

async function check(prompt, context = {}) {
  if (BLOCKED.test(prompt)) {
    return { allowed: false, reason: 'That description isn’t allowed. PixelForge only creates safe, non-explicit images.' };
  }
  return { allowed: true };
}

module.exports = { check };
