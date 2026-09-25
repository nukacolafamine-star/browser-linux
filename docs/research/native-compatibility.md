# Browser Linux compatibility experiment

Status: source/build proposal prepared on 2026-09-25. The source preparation and hash checks ran locally. The emulator, guest desktop, and JVM have **not** passed an end-to-end run of this new recipe yet. These files are separate from the working Linux-Wasm product.

## Decision

Use QEMU-Wasm's full-system x86_64 backend for the first compatibility experiment. It executes a real Linux kernel and standard x86_64 user programs. Its TCG backend turns hot guest instruction blocks into additional WebAssembly modules, with a TCI interpreter for cold blocks; it supports MTTCG. This remains an experimental fork. AArch64 is a possible second guest architecture, not a prerequisite or a way to bypass browser restrictions. [Upstream architecture and status](https://github.com/ktock/qemu-wasm)

The direct-QEMU recipe uses container2wasm's pinned dependency build stages but does not boot its container runtime. The guest is an ordinary Alpine Linux kernel, initramfs, ext4 root disk, and `/sbin/init`. The existing upstream [Alpine whole-machine demo](https://ktock.github.io/qemu-wasm-demo/alpine-x86_64.html) and its [image recipe](https://github.com/ktock/qemu-wasm/tree/master/examples/x86_64-alpine/image) establish this path; they do not establish that our exact reduced-memory configuration works.

## Build contract

- `prepare-runtime.mjs` downloads the exact Dockerfile at container2wasm commit `ecb4caa499f19f1d5cfcddd43b80aa78f98e5102`, verifies SHA-256, and appends `runtime-stage.Dockerfile`.
- QEMU-Wasm source is pinned to `8604ed49a3cde392890b014a8d5a959c8a2fe72a`, the fork revision used in that dependency recipe. Emscripten is `4.0.10`; the generated EGL source patch has its own exact input hash and declaration count.
- `qemu-proof.yml` proposes a manual-only, read-only GitHub Actions job: 45 minutes total and 35 minutes for runtime compilation. It uploads an inspection artifact and does not deploy. This is a budget, not a measured build-duration promise.
- Root integrates the separately owned `guest/` build and browser smoke before calling the experiment a success.
- For the eventual release, retain corresponding source/build inputs and all component notices, including statically linked dependencies. The proposal currently archives QEMU source and provenance; it is not a completed release-license/source bundle.

Artifact layout:

```text
runtime/qemu-system-x86_64.js        ES module default factory createQemu
runtime/qemu-system-x86_64.wasm
runtime/qemu-system-x86_64.worker.js if emitted by Emscripten
runtime/vendor/xterm-pty.js
pack/bios-256k.bin
pack/vgabios-stdvga.bin
pack/kvmvapic.bin
pack/linuxboot_dma.bin
pack/efi-virtio.rom
pack/vmlinuz-virt                   supplied by guest build
pack/initramfs-virt                 supplied by guest build
pack/rootfs.img                     supplied by guest build
provenance/
sources/qemu-wasm.tar.gz
```

The browser passes `Module.canvas`, `Module.pty`, `Module.noInitialRun=true`, `locateFile`, and `mainScriptUrlOrBlob`; creates/populates `/pack` through exported `FS`; and calls exported `callMain`. `TTY`, `FS`, `ENV`, `callMain`, `addFunction`, and `removeFunction` are exported. No JSPI is required. Headers must provide a secure, cross-origin-isolated environment for shared WebAssembly memory; the UI should probe actual capabilities, not browser brands. [Emscripten pthread requirements](https://emscripten.org/docs/porting/pthreads.html)

Suggested first boot arguments:

```text
-machine pc -m 512 -smp 1
-accel tcg,tb-size=64,thread=single
-L /pack
-kernel /pack/vmlinuz-virt -initrd /pack/initramfs-virt
-drive if=virtio,format=raw,file=/pack/rootfs.img
-append "root=/dev/vda rootfstype=ext4 rw console=ttyS0,115200"
-nic none -monitor none -serial stdio
-vga none -device virtio-vga -display sdl,gl=off
```

For serial-only diagnosis use `browser.graphics=off` in the guest command line and `-display none`. The real guest Weston/Pixman compositor is the first graphical acceptance case. SDL's browser canvas presentation is **not guest OpenGL acceleration**. The QEMU SDL integration requires OffscreenCanvas and a narrowly scoped EGL dispatch fix, following the author's [graphics experiment](https://github.com/ktock/qemu-wasm/issues/31) and [Emscripten issue 24792](https://github.com/emscripten-core/emscripten/issues/24792). The patched runtime assumes the QEMU main pthread owns its one SDL canvas.

## Memory and performance gates

Proposed proof: 512 MiB guest RAM, one vCPU, 64 MiB TCG cache, 1024 MiB fixed WebAssembly linear memory, and a 512 MiB raw guest disk. The original 256 MiB disk proposal was too small for the resolved desktop package closure. This is an experiment to measure, not a claim of suitability for phones. The browser also retains JavaScript buffers, the disk, compiled code, rendering resources, and workers outside linear memory. Guest RAM, linear memory, transfer size, and total browser process memory are different measurements.

Stock container2wasm currently gives its x86_64 QEMU build 3000 MiB linear memory and a 500 MiB TCG cache even when guest RAM is small; copying its default assets would hide a substantial resource cost. [Pinned dependency recipe](https://github.com/container2wasm/container2wasm/blob/ecb4caa499f19f1d5cfcddd43b80aa78f98e5102/Dockerfile) [Guest argument template](https://github.com/container2wasm/container2wasm/blob/ecb4caa499f19f1d5cfcddd43b80aa78f98e5102/config/qemu/args-x86_64.json.template)

A 64-bit guest does not require a memory64 host module: guest addresses are emulated. This recipe is a wasm32 host build. Passing `java -version` would not establish useful Minecraft speed. Full-system translation plus JVM-generated machine code plus the browser's own Wasm compiler adds work. Measure warmup, interpreted versus tiered Java execution, GC, input latency, and frame times; do not promise native speed.

## Acceptance ladder

1. Boot fresh without any external VM; record `uname -a`, `/proc/cpuinfo`, PID 1, mount table, guest RAM, browser capabilities, transfer sizes, and elapsed time. Execute a normal x86_64 ELF and read/write a guest file. Repeat fresh and reloaded.
2. Launch actual Weston through virtio-gpu/DRM and Pixman; identify its process and Wayland socket, open `weston-terminal`, type and run a command, and verify that pixels and input change. Preserve serial logs on failure.
3. Move to a glibc distro root disk for the ordinary vendor launcher ABI. Install its matching unmodified OpenJDK package; run version, class loading, file hashing, two Java threads, and a JIT warmup. Then test JNI and an AWT window via Xwayland if the selected launcher needs it. Alpine/musl desktop success alone does not establish glibc launcher compatibility.
4. Download and install the real launcher inside the guest, then open its UI. Separately test authentication, game download, game launch, rendering, sound, and sustained performance. Do not relabel a launcher window as a running game.

Browser-only networking through Fetch is still constrained by CORS, forbidden headers, and protocol availability. The upstream networking example documents apt mirror failures and HTTP(S)-only access. A same-origin package mirror or an explicitly disclosed network relay may be necessary; a relay is not a remote Linux VM, but it is still an external dependency. Do not silently change this requirement. [Upstream Fetch networking](https://github.com/container2wasm/container2wasm/tree/main/examples/networking/fetch)

## Alternatives checked against primary sources

| Backend | Actual scope | Decision |
| --- | --- | --- |
| [QEMU-Wasm](https://github.com/ktock/qemu-wasm) | Full-system x86_64/AArch64; experimental Wasm TCG and threads. QEMU uses GPL v2 with component-specific licenses. | Best fit for the real-kernel, ordinary-binary experiment. |
| [container2wasm](https://github.com/container2wasm/container2wasm/tree/main/examples/emscripten) | Apache-licensed packaging/tooling around separately licensed emulators/kernel; `--to-js` uses QEMU. Other routes use different, slower emulators. | Reuse source/build tooling, not an extra runtime layer. |
| [v86](https://github.com/copy/v86) | BSD-2-Clause x86 PC emulator; primary README explicitly lacks 64-bit extensions and multicore. | Good 32-bit fallback; does not meet this 64-bit launcher target. |
| [CheerpX](https://cheerpx.io/docs/overview) | Current documented platform is 32-bit x86 user mode over Linux-compatible syscalls. | Does not meet this exact full-kernel, 64-bit target. Self-hosting/redistribution also needs its [commercial license](https://cheerpx.io/docs/licensing). |
| [blink](https://github.com/jart/blink) | ISC x86_64 user-mode emulator for POSIX; current JIT emits native x86_64/AArch64 host code. | Not a ready browser full-system backend. |

QEMU's license description is [here](https://www.qemu.org/docs/master/about/license.html); inspect component licenses when assembling a release.

One misleading search result was rejected: JavaBox's older plan mentions container2wasm, but its [current implementation](https://github.com/bmarti44/javabox) is an Emscripten port of OpenJDK Zero with custom JNI/browser drawing. It is not proof that an unmodified JVM and Minecraft launcher already work inside this proposed guest.
