# Appended to a hash-verified container2wasm Dockerfile. Reuses only its build
# dependency stages, not its container guest, its 3GiB heap or its runtime args.
FROM qemu-emscripten-dev AS browser-linux-runtime-build
ARG WASM_MEMORY_MIB=1024

# Build Emscripten's SDL2 pthread port and expose its generated pkg-config file
# to QEMU's Meson dependency discovery. QEMU runs in a pthread; SDL's software
# framebuffer presents through its existing MAIN_THREAD_EM_ASM Canvas2D path.
# The browser must set ENV.SDL_RENDER_DRIVER='software' before calling main.
RUN printf '#include <SDL.h>\nint main(void) { return SDL_Init(SDL_INIT_VIDEO); }\n' > /tmp/sdl-probe.c && \
    emcc /tmp/sdl-probe.c -pthread -sUSE_SDL=2 -o /tmp/sdl-probe.js && \
    cp /emsdk/upstream/emscripten/cache/sysroot/lib/pkgconfig/sdl2.pc /glib-emscripten/target/lib/pkgconfig/

RUN EXTRA_CFLAGS="-O3 -g2 -Wno-error=unused-command-line-argument -Wno-error=unused-but-set-variable -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sALLOW_TABLE_GROWTH=1 -sINITIAL_MEMORY=$((WASM_MEMORY_MIB*1024*1024)) -sMAXIMUM_MEMORY=$((WASM_MEMORY_MIB*1024*1024)) -sALLOW_MEMORY_GROWTH=0 -sWASM_BIGINT=1 -sMALLOC=emmalloc -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createQemu -sASYNCIFY_IMPORTS=ffi_call_js -sUSE_SDL=2 -sOFFSCREENCANVAS_SUPPORT=0 $XTERM_PTY_CFLAGS" ; \
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
