# Hearth: native x86 Linux apps, launched and shown from the browser

*Design produced on 2026-09-26 by a first-principles study (five analysts, four competing architectures, a red-team review of each, and a synthesis). Research-only design. Numbers labelled "measured" come from read-only, in-memory probes run on your PC during this research, from a non-admin process. Every other number is an estimate or a published figure.*

## 1. The problem, fundamentally

Today's engine is QEMU compiled to WebAssembly. It decodes every x86 instruction in software, at 20–50 MIPS. One core of your i7-9700K runs on the order of 10,000 MIPS natively. That gap comes from the method, and tuning the emulator cannot close it. The only route to native speed is to let the CPU's own decoder run the code.

Established work does not say "native x86 from the browser is impossible." It says several separate things, and only some of them are physics:

| Limit | Kind | Breakable? At what cost? |
|---|---|---|
| x86-64 machine code can only be executed by x86-64 silicon. ARM chips must translate it; even Apple uses Rosetta for x86 Linux binaries ([Apple](https://developer.apple.com/documentation/Virtualization/running-intel-binaries-in-linux-vms-with-rosetta)) | Physical | No |
| Streaming adds latency from the speed of light, display refresh and Wi-Fi jitter | Physical | No. It can only be reduced |
| The GPU is separate silicon. Windows 10 Home has no passthrough (DDA is Server-only, [MS](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/deploy/deploying-graphics-devices-using-dda)), and GPU paravirtualization lives inside Hyper-V's own worker process ([MS](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/gpu-paravirtualization)) | Hardware + OS | Partly. Graphics commands can be forwarded to the host driver ("API remoting"), and shaders still run natively on the RTX 5060 |
| Running untrusted native code safely needs CPU-level isolation. On x86 that is VT-x with EPT. It is a privilege mode, not an emulator: guest instructions go through the same decoder unchanged | Hardware | Nothing to break. This is the tool |
| On your PC the Windows hypervisor owns VT-x, so other software must go through the Windows Hypervisor Platform (WHP) API ([MS](https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/hypervisor-platform)) | OS policy | Already usable here without admin (measured) |
| Web pages cannot give machine code to the CPU. Chrome's Native Client did this and was removed ([Chromium](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/v8H1UHnPotY)) | Browser policy | Yes, with a one-time native install. A zero-install version needs a browser vendor to add it |
| Linux programs need a Linux kernel. Windows has no user-mode syscall trap, the WSL1 "pico" interface is Microsoft-only ([MS](https://learn.microsoft.com/en-us/archive/blogs/wsl/pico-process-overview)), and user-mode attempts fell back to binary translation ([flinux](https://github.com/wishstudio/flinux/wiki/Dynamic-Binary-Translation)) | OS policy | Yes: run a real Linux kernel inside the VM, which is what WSL2 did ([MS](https://learn.microsoft.com/en-us/windows/wsl/compare-versions)) |
| On Windows 10, the WHP library exports only 29 functions. Missing: cross-process memory mapping, interrupt triggers, notification ports, device assignment | OS version | Design around it, or move to Windows 11 |

**Re-checked independently** with `tools/native/whp-check.ps1` (in memory, standard user, no admin): partition ready in 13.4 ms; a guest loop ran 4,000,000,002 x86 instructions in 0.452 s = 8.85 billion instructions per second, about one loop iteration per clock cycle, i.e. the CPU's native rate. Today's WebAssembly emulator runs 20-50 million per second.

**Measured on your PC:**
- A WHP hardware partition was created in 8–13 ms without admin rights.
- Guest code ran about 9 billion simple instructions per second.
- Each exit from the guest to user-mode code cost about 5 µs.
- The HCS API that WSL2 uses refused access without admin.

The silicon and the OS already allow native execution under browser control. What stands in the way is browser policy.

**The smart fridge.** No. A Samsung Family Hub runs Tizen with an old embedded Chromium; Family Hub 4.0 reports Chrome 56 ([UA](https://user-agents.net/string/mozilla-5-0-linux-tizen-4-0-samsung-family-hub-4-0-applewebkit-537-36-khtml-like-gecko-samsungbrowser-1-0-chrome-56-0-2924-0-mobile-safari-537-36)). It almost certainly has an ARM chip. It physically cannot decode x86 instructions, and anything that makes it run them is emulation or translation. It can be a screen and touch input for apps running natively on your PC, and that is the role this design gives it.

## 2. The new architecture: Hearth

**The core idea:** the browser stops being the CPU. It becomes the permission broker, the window manager and the screen. Apps run as hardware-isolated Linux "capsules" directly on the x86 CPU of the nearest x86 machine.

```
 Browser tab (Chrome on this PC; or phone / TV / fridge as a screen)
   Hearth Shell: catalog, one DOM window per Linux window, input, video decode
        | control: extension -> Native Messaging       | pixels/input: loopback (local),
        v                                              | WebRTC/WebSocket (remote)
 hearth-stub.exe (thin NM host) --starts--> hearthd (per-user broker)
                                              | consent, grants, image store, NAT, surfaces
                                              v
                                      hvx.exe (one per capsule; crosvm WHPX fork)
                                              | one WHvRunVirtualProcessor thread per vCPU
 ================= Windows hypervisor (VT-x + EPT) ==========================
   Capsule (VMX non-root): Linux 6.18 + Debian 13 + your apps
   kernel, JVM JIT code, Electron/V8, Steam  ->  decoded by the i7-9700K itself
                                              | virtio-gpu (Vulkan command stream)
                                              v
   GPU renderer -> NVIDIA Vulkan driver -> RTX 5060 -> NVENC to tab, or native window
```

**Components**

- **Hearth Shell (web UI).**
  - Each Linux window becomes its own DOM element. Moving, resizing and the cursor are handled locally, with no round trip to the guest.
  - Input uses Pointer Lock, Keyboard Lock and the Gamepad API; video decode uses WebCodecs.
  - The privileged UI is served from the extension's own origin, which no other program can take over.
  - Public pages can only *ask*, through a page API such as `hearth.requestCapsule({image, integrity, vcpus, memory, gpu, net})`. That API is a polyfill for something a browser could one day provide natively.
- **Bridge extension and hearth-stub.**
  - The stub is a Native Messaging host registered per-user in HKCU, so no admin is needed ([Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)).
  - Chrome kills a Native Messaging host about 2 s after its connection closes ([ref](https://textslashplain.com/2023/03/16/improving-native-message-host-reliability-on-windows/)). So the stub only authenticates the extension, then starts a detached broker.
- **hearthd (broker).**
  - Shows a native consent dialog that the page cannot draw over.
  - Stores grants bound to the combination of origin, image digest and requested resources.
  - Runs the content-addressed image store: today's 1 MiB SHA-256 chunks, expanded to a raw local image.
  - Provides user-mode NAT (initially today's Node relay), the surface server and a running indicator.
  - Exits when idle. There is no Windows service.
- **hvx (virtual machine monitor).** A fork of crosvm's WHPX backend, which already uses only functions present in Windows 10's 29 exports ([crosvm](https://chromium.googlesource.com/crosvm/crosvm/+/refs/heads/main/hypervisor/src/whpx/vm.rs); upstream lists that backend as untested, [ref](https://crosvm.dev/book/hypervisors.html)).
  - Boots the Linux kernel directly: no BIOS, VGA or IDE emulation.
  - Uses virtio-pci with MSI-X interrupts, injected with WHvRequestInterrupt.
  - Sends queue notifications as memory writes caught by WHP "doorbells". Doorbells match memory writes only, never port I/O ([MS](https://learn.microsoft.com/en-us/virtualization/api/hypervisor-platform/funcs/whvregisterpartitiondoorbellevent)). Avoid virtio-mmio, which costs two MMIO exits per interrupt ([Linux](https://raw.githubusercontent.com/torvalds/linux/master/drivers/virtio/virtio_mmio.c)).
  - Sets CPUID explicitly so the guest sees an invariant TSC and exact timer frequencies. A default WHP guest here hid the invariant TSC, and the override was accepted (measured).
- **GPU renderer.**
  - The gfxstream host ([README](https://android.googlesource.com/platform/hardware/google/gfxstream/+/refs/heads/main/README.md)) replays guest Vulkan on NVIDIA's Windows driver. The guest uses Mesa's gfxstream Vulkan driver plus Zink for OpenGL.
  - gfxstream needs host GPU memory mapped into the guest ([QEMU](https://www.qemu.org/docs/master/system/devices/virtio/virtio-gpu.html)). Windows 10 lacks the cross-process mapping call, so the renderer runs inside hvx, as Android Emulator's WHPX code does ([AEMU](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/target/i386/whpx-all.c)).
  - Output goes either to the tab through NVENC, or to a native pop-out window. NVENC documents no Vulkan input on Windows, so frames go through D3D12/CUDA interop and a copy is assumed ([NVIDIA](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html)).
  - The fallback is llvmpipe/lavapipe: rendering on the CPU as native code, which is slow.
- **Guest.** The project's existing Debian 13 + Linux 6.18 image, plus:
  - a kernel config fragment (virtio-pci, vsock, x2APIC, TSC clocksource);
  - a vsock agent for app launch, clipboard, clock correction and random-number reseeding;
  - a per-window exporter, starting with Xpra's seamless mode, which already has an HTML5 client ([Xpra](https://github.com/Xpra-org/xpra)).
- **Hearth Remote.** Off by default. Phones, TVs and the fridge pair with a QR code or short code. Transports, in order of preference: WebTransport, WebRTC, WebSocket with MSE video, WebSocket with JPEG tiles (the last one works on Chrome 56).
- **Lane W (optional, off by default).** hearthd starts the *Windows* build of the same app (Minecraft launcher, Steam, most Electron apps) and shows it. It is fully native with the native GPU, but it runs outside the VM sandbox, so enabling it is a separate trust decision.
- **Existing QEMU-Wasm engine.** Kept only as an opt-in fallback labelled "emulated". It is never chosen silently.

**Where code executes.**
- Every non-sensitive guest instruction runs directly on the i7-9700K in VMX non-root mode. That includes the kernel, HotSpot's JIT output, V8, Steam, and 32-bit code (which runs in the CPU's native compatibility mode).
- Syscalls, page faults, thread switches and JIT work stay inside the guest and cause no exits.
- Sensitive instructions (CPUID, some MSRs, device I/O and MMIO) trap and are completed in software one at a time, as in every hypervisor.
- Nothing interprets or translates the instruction stream.
- On ARM devices, nothing executes locally.

**What the browser does:** it delivers the software, collects consent, manages windows, handles input and decoding, and pairs devices. It executes no x86 code.

**New versus existing.** Everything Hearth reuses already exists and is credited: VT-x/EPT, WHP, crosvm, gfxstream, Xpra, Firecracker-style snapshots, Crostini's VM windows in a browser compositor ([Chromium](https://www.chromium.org/chromium-os/developer-library/guides/containers/containers-and-vms/)), Parsec-style streaming, and Xax's native code behind a web page ([Xax](https://www.usenix.org/legacy/event/osdi08/tech/full_papers/douceur/douceur_html/index.html)).

The research (not exhaustive) found no system that does the following:
1. A web-origin capability for hardware-VM capsules in a stock browser, with consent bound to the image digest. This is NaCl's goal, reached with hardware isolation and no recompiling.
2. A VMM designed backwards from the browser: only devices a tab can show or feed, sized to Windows 10's reduced API.
3. Snapshot-first app launch on WHP.
4. App URLs that pick the nearest x86 machine and always say which CPU is running the app, reaching down to fridge-era browsers.

The execution mechanism itself is 20 years old. The new part is the architecture and the trust model. No design exists that gets around physics.

## 3. What it achieves

**Performance** (estimates unless marked measured):
- **CPU.** About 9e9 guest instructions/s was measured, against 20–50 MIPS today. That loop is a best case; it proves direct execution, not application speed. Expect 87–99% of native per core, based on published results: Dune's SPEC2000 ran 2.9% slower, and 0.1% slower with 2 MB pages ([Dune](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-117.pdf)); WSL2 reached 87–94% of bare metal ([Phoronix](https://www.phoronix.com/review/wsl-wsl2-tr3970x/8)). Three costs remain:
  - JVM heaps can lose up to about 20% to EPT page walks when 4 KB pages are used.
  - The capsule gets 5 of your 8 cores (no SMT), so multithreaded phases can take up to about 1.6× longer.
  - Each exit costs about 5 µs (measured), so devices must be designed to exit rarely.
- **Disk and network.** An estimated 60–90% of native. Your Ethernet link currently negotiates only 100 Mbps (measured); fix the cable or switch port.
- **GPU.** Unknown until M2 below. Minecraft's current requirement is OpenGL 4.4 and a Vulkan 1.3 GPU, and Mojang plans to remove OpenGL ([wiki](https://minecraft.wiki/w/Java_Edition_hardware_requirements), [Gigazine](https://gigazine.net/gsc_news/en/20260224-minecraft-opengl-vulkan/)). Zink must therefore reach GL 4.4 over gfxstream ([Zink](https://docs.mesa3d.org/drivers/zink.html)), which is unverified. The plausible range is 20–90% of native frame rate; llvmpipe gives a low-FPS floor.
- **Display latency.** About 1–2 frames added in the tab; Parsec measured about 2 frames at 240 fps on a LAN ([Parsec](https://parsec.app/blog/parsec-game-streaming-total-latency-at-240-frames-per-second-c0818cc0daa5)). The native pop-out window adds almost nothing.
- **Minecraft estimate.**
  - Launcher window: seconds (under 20 s cold, a few seconds from a snapshot), against 15–18 minutes today.
  - Play to title screen: about 1.3–1.8× your native load time once downloads are cached, so roughly 65–110 s if native is 60 s.
  - In-game FPS depends on M2.

**Devices**
- **Native execution:** this PC; other Windows x86 PCs with VT-x (some need one UAC prompt and a reboot); Linux PCs and the Steam Deck, through a later KVM backend.
- **Screen only:** phones, Apple Silicon Macs, Snapdragon laptops, TVs, the fridge.
- **Blocked by platform policy:** consoles, and web pages on x86 Chromebooks.

**Compatibility.** A real kernel means the full Linux syscall interface.
- **Expected to work:** the Minecraft launcher, JVM apps, Electron with its sandbox, developer tools, Docker/Podman inside the guest, the Steam client.
- **Uncertain:** Proton titles, which depend on the Vulkan feature coverage gfxstream exposes.
- **Will not work:** anti-cheat that refuses VMs (Hearth will not hide that it is a VM), CUDA, nested virtualization (believed), USB passthrough, AVX-512 binaries (the 9700K lacks AVX-512), ARM-only binaries.

**Security**
- The isolation boundary is VT-x/EPT, enforced by the Windows hypervisor.
- The VMM is written in Rust and exposes only virtio devices. Legacy device emulation is where recent VM escapes happened ([Synacktiv](https://www.synacktiv.com/en/publications/on-the-clock-escaping-vmware-workstation-at-pwn2own-berlin-2025)).
- Trust is never anchored on a shared `*.github.io` origin or on port 4173, which is Vite's default ([Vite](https://vite.dev/config/preview-options)).
- Text from the guest (window titles and similar) is sanitized. Guest programs cannot spend your clicks to open windows or pickers, and link opening allows only http, https and mailto.
- NAT blocks the LAN and loopback by default.
- Snapshots are taken before login, the random-number generator is reseeded on restore ([Firecracker](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/random-for-clones.md)), and snapshot files are encrypted with DPAPI.
- Your Microsoft tokens never leave the guest; remote devices receive only pixels.
- **Remaining risks:**
  - GPU command streams reach the NVIDIA driver with less validation than Chrome gives WebGPU, so GPU access is a separate per-capsule opt-in.
  - hearthd is a new high-value target.
  - Windows 10 receives patches only through consumer ESU, until 12 Oct 2027 ([MS](https://www.microsoft.com/en-us/windows/extended-security-updates)). Reviewers disagreed about how current this PC is, so check Windows Update.

## 4. What you have to accept

- **It is not zero-install.** Once per PC: a signed per-user installer of about 10–30 MB (no admin on this PC; SmartScreen will warn until the publisher builds reputation), plus the Bridge extension from the Chrome Web Store. Then consent once per site and image. After that, launching is one click with no dialogs.
- **The code runs beside the browser.** It runs in a native process tree started through Chrome; the tab controls and displays it.
- **Admin prompts:**
  - None for the core on this PC (measured).
  - LAN viewing needs an inbound firewall rule, which Windows creates only with admin rights ([MS](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules)).
  - Large memory pages need the optional "Lock pages in memory" right.
  - Other PCs may need Virtual Machine Platform enabled plus a reboot.
- **Downloads:** the guest image is at most 350 MiB compressed and reuses existing chunks; about 50 MB of GPU drivers for the guest; then about 1–1.5 GB of Minecraft files from Mojang. You sign in inside the official launcher.
- **Fridge:** JPEG tiles over plain HTTP, roughly 10–30 fps with 80–200 ms added (estimate). It is not a secure context, so treat it as view and touch only, and never type passwords on it.
- **The PC must be on.** A web page cannot send Wake-on-LAN.
- **Windows 10 caps the design.** Windows 11 removes most of those limits. Your CPU is supported ([MS](https://learn.microsoft.com/en-us/windows-hardware/design/minimum/supported/windows-11-supported-intel-processors)); TPM and Secure Boot have not been checked. Upgrading is your decision.
- **Scale:** a minimum viable version (native desktop and launcher in the tab, CPU rendering) is about 4–6 months for one strong systems developer. The full vision is 2–4 person-years. Near-native Minecraft FPS may not be reachable on Windows 10; Lane W is the guaranteed gameplay path.

## 5. Build plan

**M0 – Measure (days, on this PC)**
1. A small Rust probe registered as a Native Messaging host. It checks that it can create partitions when launched by Chrome and at low integrity, that a doorbell fires on a 32-bit memory write in long mode, that the CPUID/TSC override works, and whether its child processes survive Chrome.
2. A baseline run: QEMU for Windows with `-accel whpx`, booting the existing Debian disk reassembled to a raw image. This needs a QEMU download you approve, and it is a measuring instrument, not the product.
3. `glxinfo`/`vulkaninfo` on llvmpipe/lavapipe, and Minecraft on llvmpipe.
4. Fix the 100 Mbps link, and check Windows Update, TPM and Secure Boot.

*Proof:* a numbers report, including the time to reach the launcher's sign-in page compared with today's 15–18 minutes.

**M1 – hvx boots the capsule (6–10 weeks).** crosvm fork, direct boot, MSI-X, timer fixes, chunk store, the existing NAT relay, and the serial console in the existing xterm.
*Proof:* a `clock_gettime` loop causes zero exits (read from WHvGetVirtualProcessorCounters); CPU benchmarks reach at least 90% of native per vCPU; launcher sign-in in under 60 s.

**M2 – GPU go/no-go (4–8 weeks).** gfxstream on NVIDIA's Windows driver with a Linux guest.
*Proof:* `vulkaninfo` reports 1.3, Zink reports GL 4.4, and Minecraft title-screen FPS is measured against native.
*Kill criterion:* if it falls short, gameplay moves to Lane W or Windows 11.

**M3 – Browser integration (6–8 weeks).** Extension, stub, broker, consent, and per-window DOM windows through Xpra.
*Proof:* a second launch takes one click and no dialogs; three apps appear as separate windows; an origin that is not pinned is refused.

**M4 – Production graphics (8–16 weeks, only if M2 passes).** NVENC interop, native pop-out window, encoder budget.
*Proof:* 240 fps camera footage shows at most 2 frames added.

**M5 – Snapshots (4–6 weeks).**
*Proof:* desktop ready in 2 s or less; two restores from the same snapshot produce different random output.

**M6 – Hardening and packaging (4–6 weeks).** Fuzzing, sandbox profiles, signed updater.

**M7 – Remote reach (4–6 weeks).**
*Proof:* a phone and the fridge can display and control the launcher, with latency measured.

## 6. Rejected alternatives

- **Faster emulation or JIT:** the gap comes from the method, and you excluded emulation.
- **Binary translation (Box64, FEX, flinux):** that is translation.
- **NaCl-style software isolation in the page:** needs recompiled binaries and is weak against Spectre and Rowhammer.
- **Syscall translation in a Windows process (WSL1-style):** Windows has no user-mode syscall trap, and the pico interface is Microsoft-only.
- **Kernel-less "process in a VM" (Noah, WinVisor):** every syscall becomes a ~5 µs exit, and the Linux interface is incomplete.
- **Own VT-x driver with Hyper-V disabled:** loses VBS and WSL, and needs a Microsoft-attested kernel driver.
- **WSL2/HCS with GPU paravirtualization:** needs admin-equivalent rights ([MS](https://learn.microsoft.com/en-us/virtualization/api/hcs/reference/hcshresult)), and Mesa's d3d12 driver documents only GL 3.3 ([Mesa](https://docs.mesa3d.org/drivers/d3d12.html)).
- **GPU passthrough:** Server-only; WHP on Windows 10 has no device assignment.
- **Plain QEMU-WHPX as the product:** a legacy PC device model with no browser-first design. Used only as the M0 measuring baseline.
- **A Chromium fork or Electron shell first:** a fork has to track Chromium's release every 4 weeks, and Electron is not safe for arbitrary origins ([Electron](https://www.electronjs.org/docs/latest/tutorial/security)).
- **x86 on the fridge's own CPU:** physically impossible without translation.