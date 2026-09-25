# GitHub Pages deployment

The committed workflow rebuilds and tests the application on pushes to `main`, then publishes only `public/` through GitHub Pages. Select **GitHub Actions** as the repository's Pages source. The site needs no application server or remote Linux machine.

On a fresh visit, `bootstrap.js` registers our existing offline service worker and reloads exactly once. The worker wraps same-origin responses with COOP `same-origin`, COEP `require-corp` and CORP `same-origin`. This includes the document and Linux worker scripts, enabling shared memory on a static host that cannot configure these HTTP headers. There is only one service worker for both isolation and offline support.

The page shows setup progress and does not start the kernel until isolation succeeds. Unsupported browsers receive a visible error instead of a reload loop. Phones initially use 128 MiB guest memory, and the Machine screen still allows another setting. Browser overhead is additional.

All assets and the manifest use relative URLs, so repository subpaths work. Browser storage, the workspace lock and offline caches are scoped to the application path, avoiding accidental collisions with another copy hosted on the same account's Pages hostname.

## Verification

`node tools/pages-test.mjs` creates its own temporary header-free server at a repository-style subpath and uses a fresh Chrome profile with a 390px touch viewport. It verifies the initial reload, shared memory, real shell, response headers, graphical file save/reload, offline boot and layout. No server needs to be running first.

The first local deployment-path test passed all seven checks, including boot and offline restore. This establishes the static-host startup path in Chrome; physical iPhone Safari has not been tested. Open the link in the phone's full browser if an embedded browser cannot expose the required APIs.

The underlying experimental kernel still has the known boot and integrity issues listed in `VERIFICATION.md`. Hosting does not change those limitations. Keep exported copies of important work.
