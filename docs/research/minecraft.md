# Minecraft acceptance research

Checked 2026-09-25. Research only: no launcher/game download, account login, purchase, or production changes. Public version metadata and unauthenticated HTTP preflights were read. The target remains browser-local computation, a genuine Linux environment, installation of the official Linux launcher, and the real game. Every capable browser is a target; browser branding is not an eligibility test.

## Current target and concrete requirements

The current release in Mojang's [version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) is **26.3**; the current snapshot is 26.4-snapshot-1. The [26.3 metadata](https://piston-meta.mojang.com/v1/packages/bc098d111a72e9f6178801544a42099bdfbb0cf2/26.3.json), read directly, specifies:

| Item | Observed requirement or evidence |
| --- | --- |
| Java | `java-runtime-epsilon`, major version **25** |
| Entry point | `net.minecraft.client.main.Main` |
| Client JAR | 41,483,720 bytes; not downloaded |
| Assets | Asset index 34; metadata reports `totalSize: 483730186` bytes, before the JVM, libraries, world saves, and installation overhead |
| Native interfaces | LWJGL **3.4.3** modules include OpenGL, Vulkan, SDL, OpenAL, ShaderC, SPVC, VMA, STB, FreeType, jemalloc, and core LWJGL |
| Linux natives | Generic `natives-linux` entries; the manifest does not list Linux ARM64 classifiers. Do not infer the architecture of every library solely from this naming. |

The [current official system requirements](https://www.minecraft.net/en-us/article/minecraft-java-edition-system-requirements) and [product requirements table](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) describe a 64-bit Linux target, Vulkan 1.3 graphics, and a minimum performance target of 1080p/30 FPS on Fast settings. Published minimum system RAM is 8 GB with a discrete GPU or 12 GB with integrated graphics; recommended RAM is 16 GB. These are whole-system requirements, **not a claim that Java must be assigned an 8 GB heap**. The cross-platform table lists x64 and ARM64; that alone does not establish an official Linux ARM64 launcher.

Graphics require a precise distinction: [1.21.9 raised the actual OpenGL requirement to 3.3](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-9), while [26.3 release notes still explicitly discuss both OpenGL and Vulkan shader compilation](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3). The published Vulkan requirement must not be turned into an unsupported claim that 26.3 has no OpenGL backend. Browser WebGL 2 is also not automatically a desktop OpenGL 3.3 implementation. WebGPU availability does not supply a Linux Vulkan ICD or OpenGL driver.

## Official launcher architecture and runtime boundary

The [official download page](https://www.minecraft.net/en-us/download) offers Debian packaging and a generic Linux tarball through `launcher.mojang.com/download/Minecraft.deb` and `launcher.mojang.com/download/Minecraft.tar.gz`. The package itself was deliberately not downloaded, so its exact current ELF headers and shared-library dependencies have not been independently inspected here.

Useful primary implementation evidence comes from the maintainers of the [Flathub launcher package](https://github.com/flathub/com.mojang.Minecraft/blob/master/com.mojang.Minecraft.yml): it obtains the official tarball as installation-time `extra-data`, and declares X11, DRI, PulseAudio, IPC, and network access. Its [architecture declaration](https://github.com/flathub/com.mojang.Minecraft/blob/master/flathub.json) is `only-arches: ["x86_64"]`. This is packaging-maintainer evidence, not a Mojang promise covering every distribution. The practical planning target is therefore the official x86-64 Linux binary, with exact binary inspection required at the later installation gate.

A wasm32 Linux kernel does not execute an x86-64 ELF program just because both are Linux. Preserving the official launcher requires a compatible native execution path, Linux userspace ABI, dynamic loader/libraries, windowing, and network services. An x86-64 emulator/dynamic translator is one possible path, but its performance must be measured. Recompiling a Java VM to Wasm would not make the proprietary native launcher executable. Java bytecode portability also does not remove the native LWJGL/JNI dependencies.

The current project's wasm32/NOMMU kernel, small guest memory, Wasm-native BusyBox userspace, and workspace snapshot limits are not yet a general-purpose desktop platform. The current 8 MiB file/32 MiB workspace policy is already smaller than the client JAR and assets. Browser memory64 support, if present, would not automatically convert this kernel and its pointers to a 64-bit architecture.

## Existing browser-local work: what it proves

| Project | Credible capability | Acceptance limitation |
| --- | --- | --- |
| [CheerpJ](https://cheerpj.com/docs/faq) | Browser-local Java runtime, currently Java 8/11/17; Swing/AWT and threads | No documented Java 25 support. It is not an execution engine for the official x86-64 Linux launcher. |
| [Browsercraft](https://github.com/leaningtech/browsercraft) | Leaning Technologies' real, unmodified Minecraft **1.2.5 (2012)** demo, using CheerpJ and an official-source JAR | Strong evidence that an old genuine Minecraft version can run locally in a browser. It does not demonstrate 26.3, the official Linux launcher, or arbitrary Linux applications. It cannot substitute for the requested acceptance test. |
| [HeadlessMc](https://headlesshq.github.io/headlessmc/) | A Java launcher implementation with [CheerpJ-related configuration](https://headlesshq.github.io/headlessmc/configuration/) | A replacement launcher. Headless, dummy-asset, or LWJGL-stub modes do not count as the rendered game. No current-Java-25 browser result was established. |
| [CheerpX](https://cheerpx.io/docs/overview) | Existing 32-bit x86 binaries and a Linux-compatible syscall environment in the browser | Its documented 32-bit target does not meet the current x86-64 launcher target. A syscall compatibility layer is not itself the requested genuine Linux kernel. |

CheerpJ's [native-library documentation](https://cheerpj.com/docs/guides/implementing-native-libraries) describes implementing native methods through JavaScript modules. It does not imply that arbitrary Linux `.so` files load unchanged. The modern game's JNI/graphics/audio stack would still need an actual implementation. Its [licensing](https://cheerpj.com/docs/licensing) also distinguishes free CDN/community use from self-hosting, redistribution, and OEM integration requiring commercial terms. An Apache-licensed integration demo does not relicense Minecraft assets.

## Network and authentication boundary

Known vendor resources and implementation evidence:

| Role | Endpoint/domain | Evidence and limits |
| --- | --- | --- |
| Official launcher | `launcher.mojang.com` | Official download page above |
| Version/asset metadata | `piston-meta.mojang.com` | Mojang manifest and 26.3 metadata above |
| Client binaries | `piston-data.mojang.com` | URLs in 26.3 metadata |
| Libraries/native JARs | `libraries.minecraft.net` | URLs in 26.3 metadata |
| Microsoft account OAuth | `login.microsoftonline.com/consumers/oauth2/v2.0/authorize` and `/token` | [Microsoft Xbox authentication documentation](https://learn.microsoft.com/en-us/xbox/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-website-authentication?view=gdk-2604) |
| Xbox user token | `user.auth.xboxlive.com/user/authenticate` | Same Microsoft documentation |
| XSTS | `xsts.auth.xboxlive.com/xsts/authorize` | Same Microsoft documentation |
| Minecraft account/token services | `api.minecraftservices.com` | Current [Prism AuthFlow source](https://github.com/PrismLauncher/PrismLauncher/blob/develop/launcher/minecraft/auth/AuthFlow.cpp) is primary implementation evidence, not an official stable API contract |

Prism's current implementation uses [POST `/launcher/login`](https://github.com/PrismLauncher/PrismLauncher/blob/develop/launcher/minecraft/auth/steps/LauncherLoginStep.cpp) after Xbox/XSTS, then [GET `/entitlements/license?requestId=...`](https://github.com/PrismLauncher/PrismLauncher/blob/develop/launcher/minecraft/auth/steps/EntitlementsStep.cpp) and a Minecraft profile step. Other implementations use `/authentication/login_with_xbox`. Do not freeze a stale tutorial's endpoint list into an assumed official contract, borrow another application's OAuth identity, or put a client secret into a static site. The official launcher should perform its own legitimate flow; a custom OAuth application would be a separate integration.

Observed unauthenticated HTTP checks, using origin `https://nukacolafamine-star.github.io`:

- GET public version manifest: HTTP 200, `Access-Control-Allow-Origin: *`.
- OPTIONS Xbox user authentication: HTTP 200, CORS allowed.
- OPTIONS XSTS: HTTP 200, requesting origin allowed.
- OPTIONS `/launcher/login` and `/authentication/login_with_xbox`: HTTP **405**, **no Access-Control-Allow-Origin** in the observed responses.

These are diagnostic preflights, not login attempts; no tokens or credentials were sent. They show that a complete browser `fetch` authentication path cannot presently be assumed. They do not establish a permanent policy for all endpoint variants or official clients.

Native Linux applications expect sockets, DNS, and TLS, while web transport remains mediated by browser APIs. CheerpJ's own [networking documentation](https://cheerpj.com/docs/guides/Networking.html) explains CORS for HTTP and a proxy/Tailscale transport for arbitrary TCP/UDP. A network relay could keep all game computation local, but it is still an external service dependency and must be stated as such. A relay is not a remote VM. Direct Java multiplayer sockets require a real transport path too; no multiplayer acceptance is implied by successful web downloads.

## Distribution and account conditions

The [Minecraft EULA](https://www.minecraft.net/en-us/eula) grants purchaser use and restricts redistribution of Mojang's game materials. The engineering approach should obtain official launcher/game assets into each user's private guest installation from vendor endpoints, preserve legitimate authentication and entitlement checks, and keep proprietary files out of this repository, public Pages bundles, and shared Linux images. A publicly accessible CDN URL is not a redistribution license. An installation test that needs account interaction must hand that interaction to the user; no password/token handling or entitlement bypass should be improvised.

## Acceptance ladder

These are capability gates across all capable browser engines, not a preferred-browser rollout. Each gate records browser engine/build, device, actual guest architecture, enabled backend, timings, and failure reason. Only claim a gate after exercising it; API exposure is not execution evidence.

1. **Define the target.** Pin current release 26.3 and its vendor manifest hashes for reproducibility. Keep the official Linux launcher requirement. An old genuine game demo can be a separate benchmark, never a silent downgrade of acceptance.
2. **Prove Linux application foundations without Minecraft.** Stable process/thread/signal/filesystem behavior; persistent files larger than 32 MiB; a deliberately chosen native 64-bit ELF hello-world, dynamic-linking test, and ordinary Linux windowed app through the intended execution path. Stop here if the execution ABI cannot support the official launcher.
3. **Prove Java 25.** Run a real `java -version` and Java-25 bytecode sample in that same environment. Exercise threads, GC, ZIP/JAR loading, NIO, TLS, JNI, and a measured safe heap workload. A host-side JS result or Java 17 VM is not a pass.
4. **Prove guest graphics, audio, and input.** A real guest LWJGL/native test creates the required graphics context, compiles shaders, renders textured geometry, produces audio after user interaction, and handles keyboard/pointer/touch mapping. Record actual renderer/driver and whether rendering is software. Browser WebGPU or WebGL success alone does not pass this gate.
5. **Prove transport and storage.** Read public metadata/CDN resources, validate digests, and establish the intended socket/CORS/relay path. Test interrupted downloads and enough persistent capacity for the JVM, libraries, game assets, and a world. Do not measure capacity by allocating until the phone crashes.
6. **Install the official launcher.** Only after the above foundations work, download from the official endpoint into the user's guest filesystem, inspect its actual ELF architecture/dependencies, verify available vendor/package hashes, and open its genuine interface. Record the actual process and filesystem evidence.
7. **Complete legitimate account flow.** User-driven Microsoft sign-in, Xbox/XSTS, and owned-game entitlement using the official launcher. No account credentials in diagnostics or artifacts. Authentication failure must remain an honest failure.
8. **Run the real current game.** Let the launcher acquire the pinned game/JVM/natives/assets; launch, create a world, move, place/break a block, save, close, and reopen the world. Capture application version, renderer, process logs, file hashes, and a visible result. Do not count stubbed graphics/headless execution or a web imitation.
9. **Measure usefulness and portability.** Run a repeatable ten-minute scene with fixed resolution/settings and record frame-time percentiles, input latency, memory, load time, and thermal/suspension behavior on each browser/device class. Compare against the same device's feasible native baseline where available. Networked play is a subsequent transport test. A universal near-native performance claim needs evidence and may not be achievable on a given browser/device.

The earliest hard blocker is native execution/ABI, followed by Java 25 and the guest graphics stack; authentication transport and resource limits are independent blockers. Fixing the present kernel startup issue is necessary progress, not evidence these gates already pass.

## Minimum honest feature probes for the UI

Use two distinct statuses: **browser capability measured** and **Linux integration implemented/tested**. Do not collapse them into a green "Minecraft ready" badge. Prefer `working`, `unavailable`, `not tested`, `blocked by page setup`, or `not integrated` with a short reason; a timeout in a background tab is inconclusive and retryable.

| Probe | Small functional test | What a pass actually establishes |
| --- | --- | --- |
| Secure context/isolation | Read `isSecureContext` and `crossOriginIsolated`; retry only after the application's real isolation setup completes | Page policy is suitable for this kernel's shared memory. A failure may be deployment configuration, not missing browser ability. |
| Wasm execution | Instantiate a tiny fixed Wasm module and execute a function returning a known value | Wasm execution works here; object presence alone is weaker. |
| Shared Wasm memory and workers | Allocate one shared Wasm page with an explicit maximum; pass the memory to a same-origin dedicated worker; run a Wasm atomic increment and a bounded wait/notify handshake; verify the result and terminate the worker | This page can execute the basic threaded mechanism the kernel requires. `SharedArrayBuffer` presence and `hardwareConcurrency` alone are insufficient. |
| memory64 (optional/future) | Compile/instantiate a tiny module declaring an i64-addressed one-page memory and execute an i64 `memory.size` result; test shared memory64 separately if a future runtime requires that combination | The feature works for this engine. It neither enlarges the current wasm32 kernel nor proves a large allocation will succeed. Do not test only an unknown Memory constructor property: ignored options could produce a false positive. |
| SIMD or other required Wasm extensions | Execute a tiny module for the actual extension required by a chosen runtime | The extension works. Do not make optional future features boot requirements for the current kernel. |
| Browser WebGPU | Request an adapter/device, run a tiny compute or offscreen render/readback check, record relevant limits/features and fallback status, then destroy resources | A browser GPU path works. Label guest graphics separately as **not integrated** until a Linux guest driver and application pass. |
| Browser WebGL 2 fallback | Create a disposable context, compile/link a tiny shader and verify a small rendered/read-back result; release it | The browser exposes the tested GL ES-style path, not desktop OpenGL/Vulkan compatibility. |
| Persistent storage | Write/read/delete a unique tiny record through the storage backend actually used; query `navigator.storage.estimate()` and `persisted()`; test OPFS separately if planned | Current storage operations work, and the estimate/persistence status can be reported. A quota estimate is not guaranteed free disk; a successful write is not a permanent retention guarantee. Ask for persistence only in the user's save/install action. |
| Guest resource budget | Report actual allocated guest memory, guest free memory, and current file/snapshot limits; keep `hardwareConcurrency` labelled as a browser-reported value | The resources this instance has, not the host's full physical RAM or available CPU entitlement. Avoid an allocation-to-failure probe and don't use optional `deviceMemory` as an exact RAM meter. |
| Downloads/transport | Fetch a tiny same-origin application resource; separately test the real public CDN path and any configured relay without credentials | Those exact paths work now. `navigator.onLine` alone does not establish Internet access; a CDN pass says nothing about Xbox or Minecraft auth CORS. |
| Input/audio | Detect the API and test pointer lock/fullscreen/audio resume only from an explicit user gesture; supply usable touch controls | The interaction path works. Do not show "unsupported browser" merely because autoplay or pointer lock awaits user interaction. |

Keep probes bounded (normally 1–3 seconds while visible), handle late promise completion and destroy resources, clean up only unique scratch storage, and do not hold up basic Linux boot for optional GPU/memory64 diagnostics. One-page memory probes use 64 KiB. Kernel regression tests still need to exercise real contended locks: a feature probe cannot rule out all JIT/concurrency bugs.

Primary platform references: [HTML agents, blocking waits, and isolation](https://html.spec.whatwg.org/multipage/webappapis.html), [WebAssembly JavaScript interface](https://www.w3.org/TR/wasm-js-api-2/), [memory64 design and encoding](https://github.com/WebAssembly/memory64/blob/main/proposals/memory64/Overview.md), [WebGPU adapter/device and fallback behavior](https://gpuweb.github.io/gpuweb/explainer/), [Storage Standard](https://storage.spec.whatwg.org/), and [File System Standard](https://fs.spec.whatwg.org/).

Current UI observations for the integrator: bootstrap errors currently suggest particular browser brands; replace that with the missing capability and recovery action. The Machine panel currently reports browser-reported logical processors, shared-memory isolation, and actual guest memory, but does not yet establish GPU/native-application capability. Keep those facts distinct when extending it.
