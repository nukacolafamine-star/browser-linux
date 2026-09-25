# Native Linux application compatibility

The target is a genuine, local Linux environment across capable browsers, including ordinary Linux binaries, a Wayland desktop, accelerated graphics, and installation and play through the official Minecraft Java launcher. No browser brand is an eligibility test. No native service, driver, hypervisor or host OS changes are required on the user's device. Building an artifact in isolated GitHub Actions is separate from running the guest: the guest always executes in the user's browser.

## Implemented development path

The direct-Wasm Linux 6.4 mode remains available independently. It cannot execute ordinary x86-64 or ARM ELF programs. The compatibility engine uses [QEMU-Wasm](https://github.com/ktock/qemu-wasm) to translate x86-64 instructions into WebAssembly, boot a normal x86-64 kernel, and execute distro programs inside that kernel. Matching the device's CPU architecture would not remove browser translation or expose hardware virtualization.

The initial guest is Alpine Linux 3.21 with a real Linux kernel, ext4 filesystem, Weston 14, DRM/Pixman compositor, and `weston-terminal`. Its virtual `virtio-vga` graphics device supplies a framebuffer. SDL presents that framebuffer to a browser canvas. This is **CPU-rendered guest graphics**, with no Linux OpenGL/Vulkan acceleration. Browser WebGL/WebGPU availability is reported separately.

The current image has a 512 MiB raw disk and the emulator reserves 1 GiB shared memory; the guest uses 256 or 512 MiB within the emulator. Disk buffers, decompression, compiled code and the browser require additional memory. The capability probe does not predict that a whole image will fit. The general-purpose Alpine Mesa/LLVM dependency closure accounts for much of this image; a smaller image needs a tailored build.

The browser integration includes a full-disk snapshot path, a private file exchange, and image retention across site updates. A snapshot is taken only after the guest's PID 1 shuts down and QEMU finishes disk cleanup. Four-MiB blocks are stored by checksum in IndexedDB with atomic current/previous pointers; stale sessions cannot overwrite a newer save. The base image is kept separately from the lightweight offline cache, and a different or missing base is rejected without deleting saved data. These storage mechanisms pass independent Chromium/WebKit tests; the complete running-guest shutdown/restore path still requires browser acceptance.

Guest networking, the official launcher and Minecraft are not installed. A separate optional Java 25 experiment does not modify the default image. Alpine's musl environment is not a demonstrated compatible runtime for the official glibc Linux launcher and LWJGL binaries. A successful kernel or JVM boot cannot be called Minecraft compatibility.

## Build and test

`.github/workflows/compatibility.yml` builds only in isolated Ubuntu jobs with read-only repository permissions. It cannot deploy Pages. The runtime uses a pinned container2wasm dependency recipe, pinned QEMU source and Emscripten 4.0.10, but launches a full Linux disk directly; it does not launch a Linux container through a syscall shim. Base distribution image/package tags are resolved at build time and their package versions are recorded, so bit-for-bit reproducibility is not claimed.

Runtime and guest artifacts are separate. After both builds succeed:

```text
node tools/compatibility-build/assemble.mjs RUNTIME_ARTIFACT GUEST_ARTIFACT
node tools/serve.mjs
node tools/compatibility-test.mjs
```

Open `http://127.0.0.1:4173/compatibility.html` for the explicit experimental session. Generated payloads live under ignored `public/compatibility/`, use one content-derived build directory, and are verified before use. The lightweight service worker excludes these large payloads from automatic caching. A Pages deployment needs a separate verified artifact delivery step; merely merging the source does not install the compatibility image.

`tools/capability-test.mjs` checks real WebAssembly i64 execution and Wasm atomic mutation through a worker in Chromium and WebKit, plus malformed/missing worker and absent isolation/shared-memory cases. `tools/compatibility-test.mjs` boots the actual guest, runs shell commands, verifies compositor/client processes, and captures the rendered canvas. An unavailable artifact or failed boot is a failed test. Portable WebKit on Windows is not a physical iPhone performance test.

The desktop acceptance test additionally requires a command typed through the graphical canvas to create a file, then reads that file through the independent serial terminal. Process markers and nonblank pixels alone cannot pass it. Set `COMPATIBILITY_PERSISTENCE=1` to add real shutdown/save/reboot checks for binary contents, ownership, permissions, symbolic links and hard links. `tools/compatibility-storage-test.mjs` exercises corruption, interrupted writes, recovery and cross-tab conflicts; `tools/compatibility-images-test.mjs` checks that site updates cannot silently replace a saved disk's base.

The native guest test in isolated CI run `36157834294` passed kernel boot, DRM/Pixman, separate Wayland client, graphical keyboard input, bidirectional 9P exchange and clean shutdown in 30.03 seconds. This validates the Linux image on native software emulation. Browser testing has reached the genuine x86-64 kernel and shell in Chromium and WebKit, and a visible Weston desktop in Chromium. Unassisted startup remains inconsistent, graphical keyboard delivery has failed the exact-file check, and the integrated save/reboot check has not passed. These partial results are not a completed browser desktop acceptance result. The public lightweight release remains separate.

Optional Java proof run `36159612528` executed Java 25 inside the same native-emulated Linux guest through the 9P exchange. Interpreter and JIT runs exercised the JAR, platform/virtual threads, GC and exact binary file contents; the log includes actual C1/C2 compilation. The interpreter run took 3.784 seconds and the JIT run 6.229 seconds. The optional runtime pack is 22,281,711 bytes compressed and is not part of the default image. Browser JVM execution, graphics/JNI and Minecraft are still unverified.

The storage suite currently passes 34 checks across Chromium and portable WebKit, including safe publication after recovering an intact previous snapshot when current metadata is corrupt. The 18 frontend cases include execution from retained, verified module bytes after their server URLs disappear. Portable Windows WebKit's ephemeral automation contexts lose CacheStorage entries on navigation; a minimal reproduction retains them in project-local persistent profiles, including across browser restart. Cache-navigation/persistence tests therefore use isolated persistent profiles on that test runtime, without changing production eligibility by browser name.

## Acceptance still required

1. Real x86-64 ELF execution and responsive Wayland rendering/input in the browser, with artifact hashes and boot timings recorded.
2. A persistent disk with Unix metadata, bounded memory, crash recovery, import/export, and enough capacity for conventional applications.
3. A compatible glibc distro image, package installation, and a real Java 25/JNI/thread/GC test inside that same guest.
4. A guest graphics bridge with validated OpenGL/Vulkan semantics and actual GPU execution. Browser texture upload alone does not pass this gate.
5. Guest network transport for vendor downloads, legitimate launcher authentication and game traffic. Browser Fetch CORS restrictions cannot be bypassed by putting a native application inside a VM; an explicit relay may be necessary.
6. Download and install the official launcher inside the guest, user-driven legitimate sign-in, acquire the owned game, create/play/save/reopen a world, and measure frame time, memory and input latency. No proprietary game files belong in the public image.

Current source-backed research: [execution backends](research/native-compatibility.md), [graphics](research/graphics.md), [concrete VirGL/WebGL adaptation requirements](research/virgl-webgl-audit.md), and [Minecraft requirements and test ladder](research/minecraft.md). These distinguish architectural feasibility from executed tests and a current game from old browser demos. [Source collection recipes](../tools/compatibility-build/SOURCE-RELEASE.md) bind dependency and guest source packages to the tested binary artifacts before public image distribution.
