# x86-64 Linux desktop engine

The goal: a genuine, local Linux distribution in a browser tab that runs ordinary Linux programs, with a Wayland desktop, a path to GPU acceleration, and the official Minecraft: Java Edition launcher installed and run inside it. No native service, driver, hypervisor or host OS change is needed on the user's device. Builds happen in isolated GitHub Actions jobs; the guest always executes in the user's browser.

The original Linux/Wasm engine (Linux 6.4 compiled to WebAssembly) remains available and unchanged. It cannot run ordinary x86-64 or ARM programs.

## Architecture

```mermaid
flowchart LR
  subgraph Tab[Browser tab]
    UI[Session page] -- canvas, keys, pointer --> QEMU[QEMU x86-64 emulator in WebAssembly]
    QEMU -- NBD over an in-page socket --> Disk[Disk worker]
    Disk -- lazy, SHA-256 verified chunks --> Static[(Published disk chunks)]
    Disk -- cached and changed chunks --> OPFS[(Browser private files)]
    QEMU -- QMP --> UI
  end
  QEMU -- Ethernet frames over WebSocket --> Relay[Local server relay]
  Relay -- TCP / UDP / DNS --> Internet
```

- **Processor.** [QEMU-Wasm](https://github.com/ktock/qemu-wasm) translates x86-64 guest code into WebAssembly (TCG), runs a normal PC (`pc` machine, SeaBIOS) and supports several virtual CPUs as Web Workers (MTTCG). The default guest CPU model is `Westmere` (x86-64-v2: SSE4.2, POPCNT, AES-NI, PCLMUL), which every current x86-64 Linux distribution and Java runtime accepts; `?cpu=max` offers AVX and AVX2 as well, at the cost of slower and less-tested translation paths. x86-64 was chosen because the official Minecraft launcher is published for x86-64 Linux only; an AArch64 build of the same emulator is possible but would not run that launcher.
- **Guest.** Debian 13 with a kernel.org 6.18 LTS kernel that has every virtual device built in (no initramfs or module loading at boot), sysvinit with a short boot script, Weston 14 (Wayland) with Xwayland for X11 programs, foot, Mesa (OpenGL 4.5 core through llvmpipe today), apt, Python, and the GTK and Chromium-embedded libraries the Minecraft launcher needs. The desktop user `user` has password-less sudo in their own browser-local machine.
- **Disk.** The 16 GiB ext4 disk is published as 1 MiB content-addressed gzip chunks; all-zero chunks are omitted, so the used 1.08 GB of filesystem costs at most 350 MiB to download, and only the parts Linux reads are fetched. A disk worker serves the image to QEMU's built-in NBD client, verifies each chunk's SHA-256, and keeps downloaded and modified chunks in the browser's origin-private file system (OPFS). Changes persist as Linux writes them; there is no separate "save" step. Guest flushes make writes durable, the chunk table is written as two alternating checksummed copies, and space released by TRIM is reused only after the new table is durable. The ext4 journal protects the filesystem if a tab closes unexpectedly.
- **Network.** QEMU's `socket` network backend sends Ethernet frames over a same-origin WebSocket to the local Browser Linux server, which runs a small user-mode IPv4 network like QEMU's slirp: ARP, DHCP, DNS forwarding to the host's resolvers, and TCP/UDP forwarding through ordinary sockets. Guest addressing matches QEMU's defaults (10.0.2.15, gateway 10.0.2.2, DNS 10.0.2.3). Only pages from the server's own origin may connect. Destinations on the user's computer, local network, link-local and other non-public ranges are refused unless the server is started with `BROWSER_LINUX_NET_LOCAL=1`. No guest code runs in the server; it forwards traffic. Static hosting without the server (for example GitHub Pages) runs the guest offline.
- **Display and input.** Weston composites on the CPU (Pixman) onto a virtio-gpu framebuffer that QEMU presents on a canvas. Keyboard and absolute pointer use virtio-input. A separate virtio mouse receives relative motion while the canvas holds pointer lock ("Game mouse"), which games such as Minecraft need for mouse-look.
- **Control.** A private virtio-9p share (`/mnt/browser`) exchanges files with the page, and a control file there requests a clean shutdown. A QMP monitor connects to the page through the same in-page socket mechanism as the disk.

## Changes to the emulator

Patches in `tools/compatibility-build/patches/qemu/` are applied to the pinned fork before compiling:

1. **virtio-input keeps undelivered events.** Upstream QEMU discarded a whole batch of input events when the guest's event queue was full. Under full emulation the guest refills that queue slowly, so key releases were lost and keys auto-repeated ("echooooo") or went missing. Batches now wait, in order, until the guest posts buffers; newer absolute pointer positions replace stale undelivered ones.
2. **Idle main loop.** Emscripten's `poll()` never blocks, so QEMU's main loop spun, sending a proxied system call to the browser's main thread on every iteration. It now sleeps up to 1 ms while idle, never past its next timer.
3. **Linear memory above 2 GiB.** The JIT's JavaScript glue read pointers as signed integers. They are now unsigned, and linear memory grows from 256 MiB up to the 4 GiB wasm32 limit, so the guest can have up to 3 GiB.
4. **`getaddrinfo()` without `AI_ADDRCONFIG`.** Emscripten fails every lookup with that flag, which prevented QEMU from reaching the in-page disk and monitor endpoints.
5. **Population count in the WebAssembly JIT.** Translated `POPCNT` read the wrong operands and left the upper half of 64-bit results undefined. The guest kernel counts bits while registering its netlink families, so it panicked at boot.
6. **More than 2 GiB of guest memory.** QEMU refuses more than 2047 MB on 32-bit hosts, and musl's `mmap()` refuses any length of 2 GiB or more there. WebAssembly addresses its linear memory as unsigned up to 4 GiB, and the JIT treats host addresses as unsigned (see 3), so the browser build allows up to 3 GiB and allocates guest RAM from the heap.
7. **JIT module management.** The JIT compiles each hot translation block into its own WebAssembly module and caps how many exist. Evicted modules were only counted as freed when the JavaScript garbage collector reported them, which a busy worker almost never does: once the first 15,000 had been compiled (before the desktop finished starting), every block ran in the interpreter. Eviction then dropped the oldest half of a thread's modules and recompiled them at once, so a busy vCPU thread compiled 4.2 million modules in 25 minutes. Evicted modules now count as freed immediately, each vCPU thread keeps up to 24,000 (48,000 in total; each costs the tab roughly 10 KiB outside WebAssembly memory, and a 120,000 cap beside a 3 GiB guest ran the tab out of memory), eviction frees a quarter with a second-chance clock that keeps recently used blocks, and an evicted block must become hot again before it is recompiled.
8. **QMP on the main loop.** QEMU serves QMP from a separate I/O thread when the monitor's chardev allows it. Emscripten's `poll()` never blocks, so that thread spun, proxying a poll to the browser's main thread on every iteration, and its requests stopped being answered after a few minutes (the page's game mouse sends its input through QMP). The browser build serves QMP from the main loop.

The build also fixes three problems outside QEMU's source. **Thread stacks:** Emscripten gives every thread a 64 KiB stack by default, while QEMU keeps a 68 KiB network receive buffer on the stack, so each packet from the network overwrote heap memory below the main loop thread's stack and the first TCP connection crashed the emulator; the browser build uses an 8 MiB main stack and 2 MiB thread stacks. **Socket reads:** a fix is applied to the Emscripten SDK before linking (`tools/compatibility-build/patch-emscripten.py`): its socket `recvmsg()` placed the second and later scatter/gather buffers at the wrong address. QEMU's NBD client reads disk data directly into guest pages with such reads, so the guest saw corrupted disk blocks (ext4 reported corrupted group descriptors) while other memory was overwritten. **libffi above 2 GiB:** the interpreter calls helpers through libffi, whose JavaScript glue indexed the heap with signed shifts; `patch-ffi-glue.py` makes them unsigned after linking, without which guests with 2 GiB or more crashed.

## In the browser

Measured in Chromium 152 on an 8-core desktop (i7-9700K), 2 virtual processors, temporary disk:

| | 1 GiB guest | 2 GiB guest |
|---|---|---|
| Serial shell | 89 s | 99 s |
| Weston desktop (Pixman) | about 2 min | about 2 min |
| Plain HTTP download through the relay | 2.9–3.9 MB/s | |
| HTTPS download (8 MB, including the handshake) | 0.9 MB/s | |
| TLS handshake with Mojang's servers (curl) | 7.1–7.7 s before the JIT fix (dropped) | 3.1 s |

Mojang's servers (Azure Front Door) close a TLS connection whose handshake is not finished within about 5 seconds of the ClientHello, which emulated OpenSSL could not meet while it parsed the 146-certificate bundle for each connection. The guest therefore points OpenSSL at the hashed certificate directory (`SSL_CERT_FILE`, `SSL_CERT_DIR`), and the launcher, whose libcurl names the bundle explicitly, runs with a small preload library (`desktop/fast-ca.c`) that substitutes the same directory lookup. Verification is unchanged; only the loading strategy differs. The launcher retries downloads that are still dropped.

The launcher's interface is a web page in an embedded Chromium (CEF 127). Chromium's helper processes (network service, storage service, GPU process, renderers) exit if their IPC channel to the main process is not connected within 15 seconds. In the browser the launcher's main process is busy for longer than that while it starts, so the network service exited, the interface page loading through it failed, and the launcher window stayed an empty gray. Chromium's `--ipc-connection-timeout` switch lengthens the wait, but the launcher does not pass its command line on to Chromium, so a second preload library (`desktop/ipc-timeout.c`) adds `--ipc-connection-timeout=600` to every helper: to the arguments of helpers started with `exec`, and to the fork requests a Chromium zygote receives for the helpers it forks. The desktop image build tests both paths.

## Verification

- `npm test` includes the user-mode network (ARP, DHCP, DNS, ICMP, TCP bulk transfer both ways with flow control, retransmission, half-close and refusals, UDP), the WebSocket relay end to end through the real server, the chunk store (lazy fetch, sharing, prefetch, copy-on-write persistence, unflushed-write semantics, TRIM quarantine, torn-table recovery), the NBD server using QEMU's negotiation, and a round trip from the Python chunker through the browser chunk store.
- `tools/compatibility-build/verify-desktop.py` runs in CI with native QEMU: it rebuilds the disk from the published chunks, boots the guest, and checks the serial shell, DNS, HTTPS and `apt-get update` through the guest's network card, Xwayland serving an X11 client, Mesa OpenGL (llvmpipe, OpenGL 4.5 core), keyboard input typed into the Wayland terminal, the file exchange, and clean shutdown. With `--launcher` it downloads the official launcher from Mojang inside the guest, waits for its windows, and checks that its interface page loaded and painted, and waits for the green "Sign in with Microsoft" button.
- `tools/desktop-test.mjs` drives the real Start Linux page in installed Chrome: boot, serial shell, Internet through the relay, exact typing through the canvas, and a file surviving shutdown and restart.

Results so far (CI run 36186934280, native TCG): serial shell in 15.7 s and desktop in 16.0 s; every check passed. The official Minecraft Launcher downloaded from `launcher.mojang.com` (its SHA-256 matched the build the Flathub and Arch packages pin), installed, and opened its X11 window through Xwayland 17 s after starting. In CI run 36212074414 its main window opened after 81 s and its interface page loaded and painted by 96 s, with the IPC timeout library loaded in 12 launcher processes.

## GPU acceleration (experimental)

The path to accelerated guest OpenGL is VirGL: Mesa's `virgl` driver in the guest sends Gallium commands through virtio-gpu to virglrenderer, which issues OpenGL ES calls that the browser executes with WebGL 2. The browser build (`gpu-stage.Dockerfile`, opt-in CI job) consists of:

- libepoxy with an Emscripten backend (`gpu/patch-epoxy.py`) that resolves every GL and EGL entry point through Emscripten's WebGL 2 implementation;
- `gpu/webgl-compat.c`: desktop-GL entry points reachable on GLES code paths (`glClearDepth`, `glDepthRange`, buffer read-mapping through `getBufferSubData`, query widening) and **virtual contexts** — a canvas has one WebGL context, while virglrenderer and QEMU expect one context per guest context, sharing objects but not state. Each virtual context keeps a shadow of the GLES 3.0 context state; switching applies only the differences;
- virglrenderer's OpenGL renderer only (no EGL, GLX, GBM, DRM, Venus or video), with Mesa's utility code taught that Emscripten is a POSIX system;
- QEMU's SDL OpenGL display using virtual contexts, rendering in QEMU's thread through OffscreenCanvas. The window requests OpenGL ES 3.0 (SDL's default of ES 2.0 made Emscripten create a WebGL 1 context), BGRA uploads are converted to RGBA, GL errors stay with the virtual context that raised them, and fence waits never block (WebGL's maximum client wait is 0);
- a main loop that returns to the browser about 60 times a second (through Asyncify): a worker's OffscreenCanvas is presented, and WebGL sync objects signal, only between tasks.

Status (`?gpu=1`, build 10409e7c6a5eadeb, Chrome): the guest boots to the desktop with Weston's GL renderer running on VirGL, `glxinfo` reports `virgl (WebKit WebGL)` with hardware acceleration, and `glxgears` renders at 14–18 frames per second through WebGL 2 with no WebGL errors.

Known WebGL 2 limits: no geometry or tessellation shaders, compute, texture buffers, conditional rendering, per-target blend enables or texture swizzle. virglrenderer reports GLSL 1.30 for an OpenGL ES 3.0 host, so Mesa offers the guest OpenGL 2.1 (and OpenGL ES 2.0). `MESA_GL_VERSION_OVERRIDE=3.3 MESA_GLSL_VERSION_OVERRIDE=330` yields a 3.3 core context, but without `GL_ARB_uniform_buffer_object` (Mesa enables it only from GLSL 1.40), which current Minecraft needs, so the game should use the default CPU renderer (llvmpipe: OpenGL 4.5 core; lavapipe: Vulkan 1.4). Reporting a higher GLSL level for WebGL 2 hosts in virglrenderer is the next step on this path. Browser WebGPU does not provide a Vulkan driver to the guest.

## Minecraft

`minecraft-launcher` (also on the desktop panel) downloads the official launcher from Mojang into the user's home directory and starts it. Nothing from Mojang is part of the image. The launcher needs Internet access through the local server, and signing in uses the player's own Microsoft account inside the launcher; Browser Linux never handles credentials. The launcher then downloads the game, its Java runtime and assets (about 1 GB) into the guest disk. Choose 3 GiB of Linux memory and 4 processors.

First start in the browser (build 10409e7c6a5eadeb, Chrome 152, i7-9700K, 3 GiB, 4 virtual processors, temporary disk), timed from clicking the panel icon on a freshly started desktop:

| Step | Time after the click |
|---|---|
| Launcher bootstrap downloaded from Mojang, checksum matched, installed | under 30 s |
| Bootstrap updated itself and the launcher (533 MB in `~/.minecraft`) | 6 min 13 s |
| Launcher main window open | 10 min 8 s |
| Interface page loaded in the embedded browser | 11 min |
| Interface running (first calls into the launcher) | 14 min 20 s |
| "Sign in with Microsoft" page on screen | by 18 min |

No launcher helper process exited during this run. Clicking **Sign in with Microsoft** opened Microsoft's sign-in page in the launcher's sign-in window about 3 minutes later (Xbox Live device authentication succeeded first). Later starts skip the downloads. Signing in, downloading and running the game have not been tested, because they need the player's account.

Expect the game to be very slow: every instruction of the game, its Java runtime and its renderer (Mesa llvmpipe, OpenGL 4.5 core) is emulated. The launcher keeps some account tokens through the Secret Service (libsecret) and logs that none is available: the desktop has a D-Bus session but no keyring. Whether that makes it ask the player to sign in again on each start has not been verified.

## Running it

```text
node tools/compatibility-build/assemble.mjs RUNTIME_ARTIFACT DESKTOP_ARTIFACT --move-chunks
node tools/serve.mjs
```

Open `http://127.0.0.1:4173/compatibility.html`. Artifacts come from the `Build browser Linux compatibility engine` workflow (`browser-linux-runtime`, `browser-linux-desktop`). Generated builds live under the ignored `public/compatibility/`.
