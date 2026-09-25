# Upstream provenance and rebuilding

The application uses [joelseverin/linux-wasm](https://github.com/joelseverin/linux-wasm). That project's newer development branch targets Linux 7.0. **This prototype uses the older published 6.4.16 artifacts**, because those were immediately runnable and testable without installing a host Linux toolchain.

The pinned artifact revision is `855319c0fed3b98e23979e364a1d6270322d3975` on the upstream `gh-pages` branch. `vendor/linux-wasm/` preserves its kernel, initramfs and JavaScript runtime. Exact hashes are in `provenance.json`. The running kernel identifies itself as `6.4.16-00012-gf3e782cb608b`, built with Clang/LLD 18.1.2.

`vendor/linux-wasm/source.tar` contains the upstream patch set and build recipes from source revision `719cd8d974dc37181204eb2db1d9b96dad260c9a`, in the 6.4-era history. This is a recipe archive, not an archive of the complete Linux/LLVM/BusyBox source trees. Its recipes fetch:

| Component | Base ref |
| --- | --- |
| Linux stable | `v6.4.16` |
| LLVM project | `llvmorg-18.1.2` |
| musl | `v1.2.5` |
| BusyBox | `1_36_1` |

## What this project changes

- Removes `.debug_*` custom sections from the prebuilt kernel; retains the original for inspection.
- Version 0.1.1 replaces twenty-seven ordinary 32-bit loads with atomic loads in four kernel ticket-spinlock functions, `wait_task_inactive` and `kcpustat_cpu_fetch`. The guarded transformation checks the exact input and function hashes, preserves all other code/data and is reproduced by `tools/kernel-fix.mjs`. This corrects startup and uptime-query stalls reproduced in WebKit; it is not a general replacement for reviewing the port's concurrency model.
- Adds a Linux guest bridge, init/profile configuration, workspace and standard null/zero/full/tty device nodes to the initramfs.
- Extends the host runtime with RPC, memory selection, shutdown and error handling, and replaces an input-buffer operation for broader browser compatibility.
- Backports the upstream `d94d6b5` task-release race correction into the older runtime.
- Adds the browser desktop, verified browser saves, exports, recovery and offline packaging.

Linux C sources and BusyBox sources were **not recompiled in this task**. Byte-for-byte reproducibility of the upstream binary from the archived recipes has not been established. No claim is made that the observed intermittent corruption has been traced to a particular component.

## Repack this application

With existing Node 22 and project dependencies installed, `npm run build` uses only files in the project and writes generated assets under `public/`. It compiles our bridge with WABT, repacks the CPIO filesystem, strips kernel debug metadata, applies the guarded spinlock correction, copies pinned xterm assets and regenerates the offline cache manifest. `public/asset-manifest.json` records SHA-256 hashes of served assets. The original prebuilt kernel is unchanged in `vendor/`; the correction is source-controlled separately from the archived upstream code.

## Separately rebuild Linux from source

This path is documented for an **already available, disposable Linux build environment**. It is not invoked by the launcher or normal build, and no such environment has been installed on Windows.

Extract `vendor/linux-wasm/source.tar` into a fresh, space-free working directory. Review its `README.md` and `linux-wasm.sh`. With the required compiler/build dependencies already available, the upstream command is:

```sh
LW_WORKSPACE="$PWD/workspace" bash linux-wasm.sh all
```

That recipe downloads and patches the four base projects, builds the modified compiler/linker, then Linux, musl, BusyBox and initramfs. It writes its toolchain to its workspace. This full path was not executed or validated here; upstream documents additional build quirks. Do not run scripts that create device nodes or install system packages on your Windows host for this prototype.

After obtaining independently built and verified kernel/initramfs artifacts, update the vendor inputs and provenance, rebuild the application, and rerun the integration and integrity tests. The next kernel upgrade should happen together with its matching runtime and userspace ABI, not by replacing one binary blindly.

## Licenses and distribution status

New project code and the upstream runtime use GPL-2.0-only. Linux and BusyBox, musl and xterm retain their respective licenses. The full GPL v2 text, original upstream license statement and both xterm MIT notices are included. Upstream base sources and patches are linked by the archived recipes.

A separate [source bundle](SOURCES.md) accompanies the GitHub release. It contains the four full upstream source releases, pinned recipes, patches, configurations, local guest/runtime additions and notices. All 15 component patches apply to the pristine sources, and the final kernel patch revision matches the running binary identifier. Full kernel binary reproducibility was not tested. The small vendor recipe archive alone is not that complete source bundle; it was refreshed from the official archive to preserve LF endings for Linux scripts and patches.
