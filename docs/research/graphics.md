# Local Linux graphics: implementation evidence and next proof

Research date: 2026-09-25. The x86-64 guest and a visible Weston desktop now run in a browser. Graphical keyboard acceptance is still failing; guest 3D acceleration is not implemented. See [current build evidence](../COMPATIBILITY.md) for the tested artifacts and remaining gates.

## Recommended proof

Run a complete x86_64 Alpine guest on the QEMU-Wasm compatibility runtime, with Linux virtio-vga DRM/KMS, the real Weston compositor using Pixman, and a real `weston-terminal` process. QEMU's SDL output delivers the guest framebuffer and browser input. All guest execution remains local. This is a genuine Linux Wayland desktop with **software rendering and no guest GPU acceleration**.

This compatibility runtime is a second execution architecture, not a conversion of ordinary x86_64 applications into the current wasm32 Linux ABI. The existing direct-Wasm Linux runtime should remain an independently tested option. Select supported runtimes and graphics features by measured capabilities and successful boot tests, not browser names or user-agent strings.

The guest recipe is in [guest/Dockerfile](../../tools/compatibility-build/guest/Dockerfile). It produces `rootfs.img` (512 MiB raw ext4), `vmlinuz-virt`, `initramfs-virt`, a package version manifest, and checksums. It uses Alpine 3.21 packages: Weston 14, DRM/Pixman, desktop shell, terminal/examples, eudev, seatd, and DejaVu fonts. The official package dependency closure totals about 423.5 MB installed: the distribution's general-purpose Mesa and LLVM shared libraries are still dependencies even when Weston selects Pixman. Reducing this substantially requires a tailored library build, not assuming that choosing a CPU renderer removes package dependencies. The image is created in an isolated Linux CI/container build with `mkfs.ext4 -d`; no OS packages, hypervisor, or drivers are installed on the user's machine.

The actual `linux-virt-6.12.111-r0.apk` from the official Alpine 3.21 x86_64 repository was inspected. Its kernel config enables `CONFIG_DRM_VIRTIO_GPU=m`, `CONFIG_DRM_BOCHS=m`, `CONFIG_INPUT_EVDEV=m`, `CONFIG_VIRTIO_BLK=m`, and `CONFIG_EXT4_FS=m`. The guest build rechecks the virtio GPU setting. Sources: [Alpine package index](https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64/), [Weston package recipe](https://github.com/alpinelinux/aports/blob/3.21-stable/community/weston/APKBUILD).

Current virtual hardware (the complete arguments live in `public/compatibility-session.js`):

```text
-M pc,i8042=off -cpu qemu64,-svm,-vmx -m 512M -smp 1
-accel tcg,tb-size=64 -nodefaults
-kernel /pack/vmlinuz-virt -initrd /pack/initramfs-virt
-drive file=/pack/rootfs.img,if=virtio,format=raw
-append "console=ttyS0,115200 root=/dev/vda rootfstype=ext4 rw"
-L /pack -vga none -device virtio-vga -display sdl,gl=off
-device virtio-keyboard-pci -device virtio-tablet-pci
-object rng-random,id=browser-rng,filename=/dev/urandom
-device virtio-rng-pci,rng=browser-rng
-serial stdio -parallel none -monitor none -nic none
```

`browser.graphics=off` on the guest command line disables graphical startup for serial debugging. Guest logs go to `/var/log/{browser-weston,weston,weston-terminal,seatd}.log`. Serial messages identify kernel boot, serial readiness, compositor socket creation and client process launch; the latter is not a substitute for verifying a rendered frame and responsive input.

Weston explicitly separates backend (input/output) from renderer (composition). Its Pixman renderer uses the CPU. Its headless backend has no input or output, so merely launching headless Weston does not display a desktop. A headless test is useful for protocol tests, but visible output requires DRM/SDL as above or an explicit capture/output implementation. [Weston documentation](https://wayland.pages.freedesktop.org/weston/toc/running-weston.html)

## Reusable existing implementations

| Project | What is demonstrated | What it does not establish |
| --- | --- | --- |
| QEMU-Wasm SDL demo | Local CPU emulation, framebuffer display, keyboard/mouse | Guest virgl/OpenGL/Vulkan acceleration; demo guest is TempleOS, not Linux |
| Greenfield | Browser Wayland compositor; local Emscripten clients; separate remote Linux path | A guest Linux compositor process; compatible drop-in binaries for this repository's Wasm ABI |
| container2wasm | Packaging Linux+container under a CPU emulator | Ready-made graphical device or working Wayland desktop in its default image |
| CheerpX/WebVM | x86 translation and Linux syscall emulation; local Xorg/KMS desktop | Running a genuine Linux kernel or a documented ready-to-use accelerated guest GPU bridge |
| VirGL/Venus | Accelerated virtual GPU stacks for native hypervisors | A browser WebGPU backend that can simply be switched on |

Greenfield's [SDK documentation](https://greenfield.app/pages/sdk/) explicitly identifies Emscripten's incomplete Linux compatibility and proposes a Wasm Linux kernel as a future solution. Its [local bitmap protocol](https://github.com/udevbe/greenfield/blob/master/protocol/web-bitmapbuf-unstable-v1.xml) wraps browser bitmap objects as Wayland buffers. This is useful design/code for a future bridge. Its [native proxy design](https://greenfield.app/pages/design/) encodes application frames on another machine and sends them to the browser; that remote execution path does not meet this project's local-only goal. Greenfield's compositor repository is AGPL-3.0; evaluate the relevant component licenses before incorporating code.

The QEMU-Wasm SDL demo author explicitly says guest acceleration such as virgl is absent. Their patch uses SDL2, `-sOFFSCREENCANVAS_SUPPORT=1`, and removal of EGL's incorrect main-thread proxy when the canvas belongs to the QEMU worker. [Author's graphics issue](https://github.com/ktock/qemu-wasm/issues/31), [Emscripten issue and exact workaround](https://github.com/emscripten-core/emscripten/issues/24792). The current project uses SDL software presentation on the browser main thread with OffscreenCanvas disabled; it does not apply the EGL workaround. This remains CPU rendering.

Exact accessible demo assets verified by HTTP on the research date:

| URL | Size/status |
| --- | --- |
| `https://zb3.me/qemu-wasm-test/basic/index.html` | 6,373 bytes |
| `https://zb3.me/qemu-wasm-test/basic/load.js` | 7,296 bytes |
| `https://zb3.me/qemu-wasm-test/basic/coi-serviceworker.js` | 4,474 bytes |
| `https://zb3.me/qemu-wasm-test/basic/qemu-system-x86_64.js` | 493,335 bytes |
| `https://zb3.me/qemu-wasm-test/basic/qemu-system-x86_64.wasm` | 44,815,169 bytes |
| `https://zb3.me/qemu-wasm-test/basic/packed.data` | Loader declares 17,919,488 bytes; contains TempleOS ISO and BIOS files |

There is no separate `qemu-system-x86_64.worker.js` or `qemu-system-x86_64.data` at that demo path (404). The alternative `eh/` demo uses native Wasm exceptions. The site's `jspi/` and `jspi-noffi/` variants explicitly require JSPI and are not a portable default. The author reports slow execution and a Firefox failure; do not turn this artifact into a compatibility claim.

[container2wasm's current GUI issue](https://github.com/container2wasm/container2wasm/issues/574) shows that adding desktop packages alone can fail with no display device. Use the explicit QEMU virtual graphics configuration, kernel modules, and compositor configuration rather than assuming `--to-js` provides graphics.

CheerpX's [2024 WebVM graphics announcement](https://labs.leaningtech.com/blog/webvm-20) documents KMS 2D with 3D/WebGPU and EGL/Wayland as future work. The current [`setKmsCanvas` API](https://cheerpx.io/docs/reference/CheerpX.Linux/setKmsCanvas) documents display output, not a guest 3D API. A [May 2026 vendor architecture article](https://labs.leaningtech.com/blog/browserpod-deep-dive) still describes desktop OpenGL/Vulkan versus WebGL/WebGPU compatibility as active development. These sources do not establish an available accelerated graphics component for this kernel.

## Acceleration remains a separate engineering project

[VirGL](https://docs.mesa3d.org/drivers/virgl.html) converts guest Gallium commands into host OpenGL; [Venus](https://docs.mesa3d.org/drivers/venus.html) serializes Vulkan and requires host Vulkan/external-memory functionality. Their native host requirements are not browser APIs. No maintained, ready-to-integrate browser virtio-gpu-to-WebGPU implementation was verified in this research. That is a bounded research finding, not a claim that no experimental implementation exists anywhere.

The achievable browser GPU route is an explicit guest graphics API bridge: guest EGL/GL or Vulkan commands must be translated into supported WebGL/WebGPU operations, with object lifetimes, synchronization, shaders, limits and error behavior implemented. [Emscripten's GL documentation](https://emscripten.org/docs/porting/multimedia_and_graphics/OpenGL-support.html) offers a WebGL-oriented GLES subset and limited emulation; it does not provide general desktop OpenGL compatibility. A browser GPU rendering the final framebuffer texture does not make guest OpenGL GPU accelerated.

Minecraft Java additionally needs a working guest JVM, JNI/LWJGL/GLFW native libraries, and the exact OpenGL features required by the chosen game version. A working Weston terminal does not validate that stack. The initial desktop should report `guestRenderer=pixman` and `guestGpuAcceleration=unavailable`; browser presentation capability should be reported separately.

## Acceptance tests before claiming a working desktop

1. Boot the exact CI artifact in fresh browser contexts with no name-based bypasses; record binary hashes, memory requirement, kernel identity and CPU architecture.
2. Confirm `/dev/dri/card0`, the real Weston PID, its Pixman renderer log, and the guest Wayland socket. Confirm a separate `weston-terminal` PID.
3. Verify a nonblank, changing canvas and real input: type a unique command in the graphical terminal, then read its result through the independent serial terminal. Kill the terminal PID through serial and verify its window disappears.
4. Test resize, focus, pointer/keyboard, repeated boot and retained workspace data. Display required memory/capability failures clearly. Include both Chromium and portable WebKit; portable Windows WebKit is not a physical iPhone test.
5. After assets load, deny external networking and prove the guest/UI continue running. Do not interpret a localhost-only guest display transport as remote execution, but avoid adding an external rendering server.
6. Measure boot time, input latency and frame rate. Only a future guest GL/Vulkan test with validated command routing, known shader output, renderer identity, and no silent CPU fallback can change the acceleration status.
