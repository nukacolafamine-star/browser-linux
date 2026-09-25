# Appended to a hash-verified container2wasm Dockerfile. Reuses only its build
# dependency stages, not its container guest, its 3GiB heap or its runtime args.
FROM qemu-emscripten-dev AS browser-linux-runtime-build
# Linear memory starts small and grows with the guest RAM chosen at launch, up
# to 65535 pages (4 GiB - 64 KiB): the JIT declares that maximum in every
# module it generates, and an imported memory may not exceed it.
ARG WASM_INITIAL_MEMORY_MIB=256
ARG WASM_MAXIMUM_MEMORY_PAGES=65535

# Browser Linux fixes for the pinned fork: keep undelivered input events
# instead of discarding them (lost key releases caused stuck, repeating keys),
# block briefly instead of spinning when the main loop is idle, and treat
# pointers above 2 GiB as unsigned in the JIT's JavaScript glue.
COPY patches/qemu/ /tmp/qemu-patches/
RUN cd /qemu && for patch in /tmp/qemu-patches/*.patch; do \
      git apply --check "$patch" && git apply "$patch" && echo "applied $patch" || exit 1; \
    done

# 9P2000.L replies use Linux errno numbers. Emscripten uses the WASI numbering.
# Verify the pinned source before changing the host-to-guest protocol boundary.
COPY patch-9p-errno.py 9p-errno-emscripten.h probe-9p-errno.c test-9p-errno.py /tmp/
RUN python3 /tmp/test-9p-errno.py /qemu/hw/9pfs/9p-util.h && \
    python3 /tmp/patch-9p-errno.py /qemu && \
    emcc /tmp/probe-9p-errno.c -I/tmp -sENVIRONMENT=node -sEXIT_RUNTIME=1 -o /tmp/probe-9p-errno.js && \
    node /tmp/probe-9p-errno.js

# Build Emscripten's SDL2 pthread port and expose its generated pkg-config file
# to QEMU's Meson dependency discovery. QEMU runs in a pthread; SDL's software
# framebuffer presents through its existing MAIN_THREAD_EM_ASM Canvas2D path.
# The browser must set ENV.SDL_RENDER_DRIVER='software' before calling main.
RUN printf '#include <SDL.h>\nint main(void) { return SDL_Init(SDL_INIT_VIDEO); }\n' > /tmp/sdl-probe.c && \
    emcc /tmp/sdl-probe.c -pthread -sUSE_SDL=2 -o /tmp/sdl-probe.js && \
    cp /emsdk/upstream/emscripten/cache/sysroot/lib/pkgconfig/sdl2.pc /glib-emscripten/target/lib/pkgconfig/

RUN EXTRA_CFLAGS="-O3 -g2 -Wno-error=unused-command-line-argument -Wno-error=unused-but-set-variable -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sALLOW_TABLE_GROWTH=1 -sINITIAL_MEMORY=$((WASM_INITIAL_MEMORY_MIB*1024*1024)) -sMAXIMUM_MEMORY=$((WASM_MAXIMUM_MEMORY_PAGES*65536)) -sALLOW_MEMORY_GROWTH=1 -sWASM_BIGINT=1 -sMALLOC=emmalloc -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createQemu -sASYNCIFY_IMPORTS=ffi_call_js -sUSE_SDL=2 -sOFFSCREENCANVAS_SUPPORT=0 $XTERM_PTY_CFLAGS" ; \
    emconfigure ../configure --static --target-list=x86_64-softmmu --cpu=wasm32 --cross-prefix= \
      --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs --enable-sdl --enable-pixman \
      --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" \
      --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS,callMain,ENV" && \
    emmake make -j 3 qemu-system-x86_64

RUN mkdir -p /out/runtime/vendor /out/pack /out/provenance /out/sources && \
    cp qemu-system-x86_64 /out/runtime/qemu-system-x86_64.js && \
    cp qemu-system-x86_64.wasm /out/runtime/ && \
    if test -f qemu-system-x86_64.worker.js; then cp qemu-system-x86_64.worker.js /out/runtime/; fi && \
    cp node_modules/xterm-pty/index.js /out/runtime/vendor/xterm-pty.js && \
    cp /qemu/pc-bios/bios-256k.bin /qemu/pc-bios/vgabios-stdvga.bin /qemu/pc-bios/vgabios-virtio.bin /qemu/pc-bios/kvmvapic.bin /qemu/pc-bios/linuxboot_dma.bin /qemu/pc-bios/efi-virtio.rom /out/pack/ && \
    printf '%s\n' '{"presenter":"sdl2-software-canvas2d","canvasOwner":"browser-main-thread","offscreenCanvas":false,"eglSourceModified":false,"requiredEnvironment":{"SDL_RENDER_DRIVER":"software"}}' > /out/provenance/graphics.json && \
    printf '%s\n' '{"exitRuntime":true,"shutdownBoundary":"normal QEMU main return after qemu_cleanup drains block I/O","saveOnlyAfter":"onExit with status 0 following requested guest shutdown"}' > /out/provenance/shutdown.json && \
    cp /qemu/COPYING /out/provenance/QEMU-COPYING && \
    cp /qemu/COPYING.LIB /out/provenance/QEMU-COPYING.LIB && \
    cp /tmp/9p-errno-patch.json /out/provenance/ && \
    cp /tmp/patch-9p-errno.py /tmp/9p-errno-emscripten.h /tmp/probe-9p-errno.c /out/sources/ && \
    mkdir -p /out/sources/qemu-patches && cp /tmp/qemu-patches/*.patch /out/sources/qemu-patches/ && \
    printf '{"initialMiB":%s,"maximumPages":%s,"maximumBytes":%s,"growable":true}\n' "$WASM_INITIAL_MEMORY_MIB" "$WASM_MAXIMUM_MEMORY_PAGES" "$((WASM_MAXIMUM_MEMORY_PAGES*65536))" > /out/provenance/memory.json && \
    git -C /qemu rev-parse HEAD > /out/provenance/qemu-commit.txt && \
    git -C /qemu archive --format=tar HEAD | gzip -n > /out/sources/qemu-wasm.tar.gz

COPY generated/firmware/ /out/provenance/firmware/
COPY verify-firmware.py /tmp/verify-firmware.py
RUN python3 /tmp/verify-firmware.py && \
    cp /qemu/.gitmodules /out/provenance/firmware/QEMU-gitmodules && \
    cp /qemu/roms/Makefile /out/provenance/firmware/QEMU-roms-Makefile && \
    cp /qemu/pc-bios/README /out/provenance/firmware/QEMU-pc-bios-README

FROM scratch AS browser-linux-runtime
COPY --from=browser-linux-runtime-build /out/ /
