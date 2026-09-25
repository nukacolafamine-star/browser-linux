# Real guest GPU feasibility audit

Inspected 2026-09-25. This is a source audit, not a compiled renderer or an acceleration claim. The current QEMU proof uses Weston/Pixman and SDL/Canvas2D; its graphics are CPU rendered.

## Finding

A reduced VirGL-to-WebGL2 backend is a plausible engineering project, but simply enabling QEMU VirGL and compiling upstream virglrenderer with Emscripten will not produce a correct renderer. The shortest credible next experiment is a renderer-only VirGL command stream test, before rebuilding the full VM. The following obstacles are concrete rather than assumptions about browser brands.

| Mechanism | Exact observed source behavior | Browser adaptation required |
| --- | --- | --- |
| API floor | `vrend_renderer_init` accepts a host GLES context >= 3.0 and initializes optional features from its actual version/extensions. | WebGL2 is a useful baseline. Do not advertise desktop GL, GLES 3.1/3.2, geometry/tessellation/compute/SSBO features merely because virgl protocol can encode them. |
| GL dispatch | Meson requires libepoxy >= 1.5.4 for `vrend`. Epoxy uses native shared-library discovery and GL function dispatch. | A static Emscripten GL dispatch backend and accurately filtered version/extension reporting are needed. Linking native libepoxy unchanged is not a browser driver. |
| Context creation | The stock non-Windows/non-Darwin EGL configuration requires libdrm and GBM. Renderer callbacks can supply external contexts instead. | Disable EGL/GLX winsys platforms and provide WebGL context callbacks. Native GBM/device descriptors are not available to browser code. |
| Context sharing | `vrend_renderer_create_sub_ctx` requests `shared=true` for contexts beyond the initial context. It expects host GL object sharing. | WebGL does not expose cross-context sharing. Emscripten 4.0.10 `eglCreateContext` ignores its share-context argument and returns its default-context handle. Correct multi-context support needs explicit state virtualization on one WebGL context, or a resource replication design. Returning one handle without restoring state is not sufficient. |
| Buffer readback | `vrend_transfer_send_iov` calls `glMapBufferRange(..., GL_MAP_READ_BIT)` for GL buffers; vertex attribute emulation also uses read mapping. | Emscripten 4.0.10 `FULL_ES3` explicitly rejects `MAP_READ` and `MAP_UNSYNCHRONIZED`. Rewrite read mapping using `getBufferSubData` into Wasm memory, with correct offsets/lifetimes. `FULL_ES3=1` alone does not solve this. |
| Fences | VirGL can create a shared surfaceless context for its optional threaded synchronization path. | Disable threaded sync initially; poll fences without blocking the browser event loop. Validate guest fence ordering and GPU completion, not only frame appearance. |

Later GL extensions are often capability-gated, so their absence alone does not prove that a reduced backend is impossible. The sharing/readback/dispatch differences above still require real code. Vulkan/Venus is not a shortcut: a native Vulkan loader, file-descriptor/resource-sharing assumptions and Vulkan-to-WebGPU translation would introduce a different driver project.

## Smallest useful experiment

Use pinned virglrenderer `816774484d2c32a0d9dbfdb5d778e3fac4807967` and Emscripten 4.0.10. Keep the existing VM build intact. Create a separate 20-minute isolated CI build only after the dispatch/context adapter exists; an unmodified upstream compile is expected to fail or yield unusable native dispatch.

Candidate Meson scope: `-Dvrend=true -Dvenus=false -Ddrm-renderers=[] -Dplatforms=[] -Dvideo=false -Dtests=false -Dfuzzer=false -Ddefault_library=static`, with an Emscripten cross file and browser dispatch shim replacing epoxy. Candidate Emscripten GL flags: `-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sFULL_ES3=1`; the latter is only a partial write-mapping aid. These are proposed settings, not a verified build recipe.

Acceptance sequence:

1. Compile with undefined symbols forbidden; record the exact unresolved GL/platform API list. No no-op rendering stubs.
2. Initialize `VIRGL_RENDERER_USE_GLES` through external callbacks and export the actual caps. Reject unsupported guest command types explicitly.
3. Submit a real recorded VirGL vertex/fragment triangle command stream, render into a guest resource, read back pixels, and compare known colors. Instrument WebGL draw calls to establish that guest commands reached the GPU API.
4. Upload a buffer, copy/read it back through the VirGL transfer API, and compare all bytes. This directly tests the read-mapping adaptation.
5. Alternate two VirGL contexts with distinct shaders, textures, blend/depth state and viewports. Verify context/resource behavior; one-context triangle success is insufficient.
6. Check fence ordering, repeated frames, context loss, and main-thread responsiveness on independent WebGL2 engines using feature probes.
7. Only then integrate `virtio-vga-gl`/VirGL in QEMU, boot ordinary guest Mesa, and verify the guest renderer reports VirGL rather than llvmpipe. Run a guest GL test and a real accelerated Weston session. This does not by itself establish Minecraft compatibility or speed.

## Primary sources

- [Mesa's VirGL architecture](https://docs.mesa3d.org/drivers/virgl.html)
- [Pinned virglrenderer Meson dependencies and platforms](https://gitlab.freedesktop.org/virgl/virglrenderer/-/blob/816774484d2c32a0d9dbfdb5d778e3fac4807967/meson.build)
- [Pinned renderer initialization, context creation and transfer paths](https://gitlab.freedesktop.org/virgl/virglrenderer/-/blob/816774484d2c32a0d9dbfdb5d778e3fac4807967/src/vrend/vrend_renderer.c): `vrend_renderer_init`, `vrend_renderer_create_sub_ctx`, `vrend_transfer_send_iov`, `vrend_renderer_use_threaded_sync`.
- [libepoxy native dispatch implementation](https://github.com/anholt/libepoxy/blob/master/src/dispatch_common.c)
- [Emscripten 4.0.10 EGL context implementation](https://github.com/emscripten-core/emscripten/blob/4.0.10/src/lib/libegl.js#L314)
- [Emscripten 4.0.10 buffer mapping rejection](https://github.com/emscripten-core/emscripten/blob/4.0.10/src/lib/libwebgl.js#L4162)
- [Emscripten 4.0.10 getBufferSubData implementation](https://github.com/emscripten-core/emscripten/blob/4.0.10/src/lib/libwebgl2.js#L109)
- [Emscripten GL support modes](https://emscripten.org/docs/porting/multimedia_and_graphics/OpenGL-support.html)
