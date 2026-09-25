# Compatibility source release inventory

This file records engineering evidence and the collection procedure. It is not a claim that unverified artifacts already form a complete source release. Do not publish the new compatibility image/runtime until its exact source artifacts and notices have been checked. The existing native-Wasm Linux release is a separate artifact set.

## Current binary evidence

Runtime build `36156507966` compiled successfully. Its Wasm SHA256 is `51c9c85b16d50ecb219a22b17698ef34ab067628e2ff14d635fad4f267e22924` (13,232,294 bytes). Its generated JavaScript defaults `noExitRuntime` to false, includes `exitRuntime`, and invokes `Module.onExit` when runtime keepalives allow shutdown. The artifact contains `shutdown.json`, six firmware hashes, pinned firmware commits and license files. Actual guest poweroff, disk flush, callback and restore still require behavioral testing.

## Present and missing material

| Component | Current binary artifact | Source collection target |
| --- | --- | --- |
| QEMU-Wasm, commit `8604ed49a3cde392890b014a8d5a959c8a2fe72a` | Top-level `git archive`, COPYING/COPYING.LIB, build recipe | Retain actual configured source tree, fetched Meson subprojects, generated config/logs, npm lock, project patches/recipe. Ordinary git archive does not include submodule contents. |
| SeaBIOS/iPXE firmware; EDK2 EfiRom packaging tool | Exact ROM hashes, submodule pins, principal license texts and links | Fetch pinned trees and nested submodules; include source/build configs. These pins identify the sources registered by QEMU, but do not independently reproduce bundled ROM bytes. Upstream ROM-build correspondence remains a release check. |
| GLib 2.75.0, its fallback pcre2/gvdb, libffi commit `adbcf2b247696dde2667ab552cb93e0c79455c84`, zlib 1.3.2, pixman 0.42.2 | Statically linked code; sources absent from original artifact | Copy actual dependency-stage sources including fetched fallbacks and generated configuration. Reject unaccounted static libraries. Include resolver stub source and the build scripts that change GLib feature macros. |
| Emscripten 4.0.10 runtime, libc/C++/compiler runtime, SDL2 port | Generated JS and linked code; sources absent from original artifact | Include Emscripten source tree and actual port source cache, with embedded notices. Exclude binary compiler caches and build objects; retain actual source/config needed to rebuild the full application. |
| xterm-pty 0.10.1 | Distributed JS and linked JS library | Include installed package/lock plus source commit `cfcbc7e2145d03a0afef45939e3971becb2b4443` identified by published npm metadata. |
| Alpine guest closure, including Linux, Mesa and LLVM | Full root disk, package-version list; newer guest also exports installed APK database and repositories | Group installed packages by origin/version/aports commit. Collect each original recipe, local patches/configs/install scripts and checksum-verified upstream sources with `abuild fetch verify srcpkg`. No moving branch/source-version inference. |
| Browser UI and custom guest scripts | Project files and bundled vendor JS | Include exact project commit, npm lock, vendor notices/source where required and complete guest image recipe. Review the UI bundle separately; runtime collection cannot prove its closure. |

The GPLv2 text bundled with QEMU defines corresponding source to include source for all modules plus associated interface definitions and scripts controlling compilation/install. GLib's own license and applicable component notices also need preserving. Source-download URLs alone are not the source payload that these collectors produce. Avoid assuming one top-level license covers every bundled library, firmware, font or guest package.

## Executable collection

`.github/workflows/compatibility-sources.yml` is an isolated, read-only workflow. It accepts the exact runtime and guest Actions run IDs, has a 20-minute limit per job, uploads source artifacts only, and never publishes Releases or Pages. The push trigger applies only to its own file on `feature/portable-compatibility`, so the first branch push can register/run it without changing the default branch.

Runtime job:

1. Prepare the same hash-checked container2wasm dependency recipe and append `source-stage.Dockerfile`.
2. Reuse the existing compiler/dependency cache. Copy actual sources from the dependency stages, collect firmware trees recursively and retain provenance.
3. Verify the collected build's Wasm hash equals the requested tested runtime artifact. A mismatch fails instead of claiming correspondence.
4. Upload separate hashed archives. Each archive must be below 1.9 GB. Include an exact project source archive.

Guest job:

1. Download the exact guest artifact and verify its checksums.
2. Match `apk-installed.txt` against every entry in `package-versions.txt`. Missing origin, commit or license metadata fails collection.
3. Locate each origin at its recorded full aports commit in the official Alpine mirror. Run APKBUILD only inside the disposable source-collection container.
4. Explicitly verify upstream checksums before `srcpkg` (the upstream `srcpkg` function fetches but does not itself call verify). Retain the full original package recipe in addition to the source archive.
5. Upload the per-origin archives, package-to-origin manifest and guest binary checksum manifest. Grouping by origin avoids duplicating Linux/Mesa/LLVM source for each subpackage.

On an isolated Linux runner the same targets can be invoked with:

```sh
node tools/compatibility-build/prepare-runtime.mjs
node tools/compatibility-build/prepare-sources.mjs
docker buildx build --file tools/compatibility-build/generated/sources.Dockerfile \
  --target browser-linux-runtime-sources \
  --output type=local,dest=runtime-sources tools/compatibility-build
# Copy the exact guest's apk-installed.txt/package-versions.txt/apk-repositories.txt
# into tools/compatibility-build/generated/source-input first.
docker buildx build --file tools/compatibility-build/guest-sources.Dockerfile \
  --output type=local,dest=guest-sources tools/compatibility-build
```

## Verification still required before public redistribution

Collectors deliberately mark manifests `reviewRequired: true`. Collection success is not the whole release check. Review the actual final linker inputs and embedded notices, associate every archive with the tested runtime/guest checksums, check the firmware source/build correspondence, and rebuild the full application/guest from the collected source in a clean environment. Resolve any missing download, unexpected library, version mismatch or incomplete package recipe; do not silently skip it. A public source release must remain available with the corresponding downloadable binaries and be linked clearly from the download page. GitHub Actions' expiring artifacts are a staging area, not the permanent source release.

Primary references:

- [Pinned QEMU license text](https://github.com/ktock/qemu-wasm/blob/8604ed49a3cde392890b014a8d5a959c8a2fe72a/COPYING)
- [Pinned container2wasm build recipe](https://github.com/container2wasm/container2wasm/blob/ecb4caa499f19f1d5cfcddd43b80aa78f98e5102/Dockerfile)
- [Alpine APK origin/commit/license fields](https://github.com/alpinelinux/apk-tools/blob/v2.14.6/src/package.c)
- [Alpine 3.14.1 source-package implementation](https://github.com/alpinelinux/abuild/blob/3.14.1/abuild.in)
- [Emscripten port source handling](https://github.com/emscripten-core/emscripten/blob/4.0.10/tools/ports/__init__.py)
- [Published xterm-pty 0.10.1 metadata](https://registry.npmjs.org/xterm-pty/0.10.1)
