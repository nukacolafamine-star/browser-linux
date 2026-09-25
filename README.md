# Browser Linux 0.1.1

A working experimental Linux workstation in a browser. It boots a genuine Linux 6.4.16 kernel compiled to WebAssembly, with a BusyBox shell, a file browser and a text editor sharing the kernel's real filesystem. Computation happens on your device.

**[Open Browser Linux](https://nukacolafamine-star.github.io/browser-linux/)** in your phone or desktop browser. First-time setup downloads the application and reloads once to enable shared memory.

**Your Windows installation is unchanged.** This project runs in a browser sandbox. Its small local server serves static files; it cannot execute Linux commands or modify your Windows files. No WSL, Docker, drivers, services, administrator access or system configuration changes are needed to run this copy.

## Start

On this computer, double-click **Start Browser Linux.cmd**, then open **http://127.0.0.1:4173** in a browser with shared WebAssembly memory. If the preview server is already running, just open the address. Keep the server window open while using it; Ctrl+C stops the server.

The launcher uses the Node.js already installed on this computer. It does not install software. From a terminal in this folder, the equivalent is:

```text
node tools/serve.mjs
```

The ready-to-run files are included, so `npm install` and a kernel build are unnecessary for normal use. Opening `public/index.html` directly will not work: this kernel needs shared memory and the isolation headers supplied by the server. [SharedArrayBuffer requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer).

## Try it

In Terminal:

```sh
uname -a
cat /proc/meminfo
printf 'Created by Linux\n' > /home/web/hello.txt
ls -l /home/web
```

Open **Files**, select `hello.txt`, edit it and save. Back in Terminal, `cat /home/web/hello.txt` shows the same contents. BusyBox provides tools including `sh`, `vi`, `find`, `grep`, `awk`, `sed`, `tar` and `sha256sum`. The commands run inside Linux.

## What is included

- Terminal with keyboard input, resize support and touch-accessible special keys.
- File browsing, UTF-8 editing, file import/export, folders and deletion.
- Automatic browser saves every 10 seconds; manual saves and portable JSON backups.
- Verification of graphical file writes, backup checksums and restored workspace contents.
- A previous saved version and backup export even if Linux stops.
- Offline loading after the application reports **Available offline**.
- Memory choices of 128, 256 or 512 MiB, plus additional browser overhead.

Only `/home/web` is persisted. Files elsewhere reset with each kernel boot, and running processes are not saved. Backups preserve file contents, directories and symlink targets, but not Unix ownership, modes, timestamps, hard-link relationships or extended attributes. Limits are 8 MiB per file, 32 MiB per workspace and 2,048 entries. Active shell writes can make a save inconsistent; those saves are rejected and can be retried after the command finishes.

Keep exported backups of work you care about. Browser data can be cleared, and persistent storage is granted at the browser's discretion. [Browser storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).

## Current boundary

This is the first working foundation, not a finished general-purpose Linux distribution. In the default Linux/Wasm mode, the desktop interface is a browser application; Linux supplies the kernel, processes, command-line programs and filesystem. That mode has no X11/Wayland desktop, conventional package repository, guest networking, GPU acceleration or ability to launch ordinary x86/ARM Linux binaries. Applications need to target its experimental Linux/Wasm ABI.

A separate [x86-64 and Wayland compatibility engine](docs/COMPATIBILITY.md) is in development. It uses real QEMU-Wasm, a standard Linux kernel and Weston, with browser feature checks rather than a browser allowlist. Browser desktop, full-disk save/restore and application acceptance are tracked separately; this work does not establish Minecraft or GPU acceleration support.

**Intermittent binary-data corruption and occasional boot stalls were observed during development. Their root causes remain unresolved.** Subsequent repeated restart tests passed. Writes and restores now have integrity checks that stop a failed session before it can replace the saved backup. A boot that does not reach the shell times out and offers a restart. These checks do not establish that the underlying kernel is reliable or detect every possible later corruption. Use this as a development prototype, not the only copy of important data.

Version 0.1.1 corrects the kernel's shared-lock polling instructions after a reproducible WebKit startup stall. It also reports the startup stage and preserves worker diagnostics behind **Boot details → Copy report**. The kernel and files still run locally.

Chrome, Edge and a portable WebKit engine were tested on this Windows machine. The user subsequently confirmed that version 0.1.1 works well on their iPhone. Portable WebKit tests remain separate from physical iPhone tests. The responsive phone layout was tested at 390 pixels. Support is determined by capabilities, not a browser allowlist; "any browser" and "all native performance" remain objectives rather than demonstrated capabilities.

The `feature/portable-compatibility` branch adds an isolated x86-64/Wayland development path. See [compatibility implementation and acceptance](docs/COMPATIBILITY.md). It preserves this working lightweight engine and does not claim Minecraft or guest GPU acceleration.

## Development

Node 22 was used. For project-local dependencies and rebuilds:

```text
npm ci --cache .cache/npm
npm run build
npm test
```

`build` removes kernel debug metadata, applies the guarded shared-lock instruction correction to the pinned kernel, repackages the BusyBox image, compiles our small guest bridge, and rebuilds offline assets. It does **not** compile Linux from C. See [upstream provenance and the separate source-build path](docs/UPSTREAM.md).

With the local server running and Chrome/Edge already installed:

```text
npm run test:browser
node tools/extended-test.mjs
node tools/recovery-test.mjs
```

These use temporary browser profiles under this project. See [verification results](docs/VERIFICATION.md), [architecture](docs/ARCHITECTURE.md) and [next development stages](docs/ROADMAP.md).

## Host elsewhere

`public/` is a static application. GitHub Pages is supported through the included deployment workflow and a service worker that prepares browser isolation on the first visit. See [GitHub Pages deployment](docs/GITHUB-PAGES.md). A host that supports custom headers can directly serve `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `.wasm` as `application/wasm`. No Linux server backend is required. The supplied development server binds only to `127.0.0.1`, so other devices cannot connect to that local address.

## Credits and license

Built on [Joel Severin's Linux/Wasm port](https://github.com/joelseverin/linux-wasm), with Linux, musl, BusyBox and xterm.js. Project code is GPL-2.0-only; component licenses remain applicable. See `LICENSE`, `vendor/`, [provenance](docs/UPSTREAM.md) and `provenance.json`.
