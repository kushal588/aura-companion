const ASSET_PREFIXES = ['/assets/'];
const ASSET_EXTENSIONS = [
  '.js',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.json',
  '.wasm',
];

function isAssetPath(pathname) {
  if (ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return ASSET_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

/**
 * Serves the built SPA. Asset hits pass straight through; a missed asset stays
 * a 404 so a broken bundle is visible instead of silently loading HTML; every
 * other miss falls back to index.html so client-side routes deep-link correctly.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    let response;
    try {
      response = await env.ASSETS.fetch(request);
    } catch {
      response = undefined;
    }

    if (response && response.status !== 404) {
      return response;
    }

    if (response && isAssetPath(url.pathname)) {
      return new Response('not found', { status: 404 });
    }

    return env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
  },
};
