# Appended after runtime-stage.Dockerfile. Builds the GPU variant of the
# emulator: virtio-gpu with VirGL, rendering the guest's OpenGL through the
# browser's WebGL 2. Kept separate from the CPU-rendering runtime.
FROM browser-linux-runtime-build AS browser-linux-gpu-deps
ARG EPOXY_COMMIT=c84bc9459357a40e46e2fec0408d04fbdde2c973
ARG VIRGL_COMMIT=816774484d2c32a0d9dbfdb5d778e3fac4807967
COPY gpu/ /tmp/gpu/
RUN printf '%s\n' '#!/bin/bash' \
      'args=(); for arg in "${@:2}"; do args+=("${arg//-Werror=unused-command-line-argument/-Wno-error=unused-command-line-argument}"); done' \
      'exec "$1" "${args[@]}"' > /gpu-cc-wrap.sh && \
    printf '%s\n' '[host_machine]' "system = 'emscripten'" "cpu_family = 'wasm32'" "cpu = 'wasm32'" "endian = 'little'" \
      '[binaries]' "c = ['bash', '/gpu-cc-wrap.sh', 'emcc']" "cpp = ['bash', '/gpu-cc-wrap.sh', 'em++']" \
      "ar = 'emar'" "ranlib = 'emranlib'" "pkgconfig = ['pkg-config', '--static']" > /gpu-cross.meson && \
    printf '%s\n' "prefix=/emsdk/upstream/emscripten/cache/sysroot" 'Name: egl' 'Description: Emscripten EGL over WebGL' 'Version: 1.5' 'Libs: -lEGL' 'Cflags:' \
      > /glib-emscripten/target/lib/pkgconfig/egl.pc && \
    printf '%s\n' 'Name: glesv2' 'Description: Emscripten OpenGL ES over WebGL 2' 'Version: 3.0' 'Libs: -lGL' 'Cflags:' \
      > /glib-emscripten/target/lib/pkgconfig/glesv2.pc

# libepoxy: all lookups resolve to Emscripten's WebGL 2 through webgl-compat.c.
RUN git init -q /epoxy && cd /epoxy && git fetch -q --depth=1 https://github.com/anholt/libepoxy "$EPOXY_COMMIT" && \
    git checkout -q FETCH_HEAD && python3 /tmp/gpu/patch-epoxy.py /epoxy && \
    cp /tmp/gpu/webgl-compat.c src/webgl-compat.c && \
    python3 -c "import pathlib; p = pathlib.Path('src/meson.build'); s = p.read_text(); old = \"'dispatch_common.c',\"; assert s.count(old) == 1; p.write_text(s.replace(old, old + \" 'webgl-compat.c',\"))" && \
    CFLAGS="$CFLAGS -pthread" meson setup _build --cross-file=/gpu-cross.meson --prefix=/glib-emscripten/target \
      --default-library=static --buildtype=release -Degl=yes -Dglx=no -Dtests=false -Ddocs=false && \
    ninja -C _build install && \
    grep -q 'epoxy_has_egl=1' /glib-emscripten/target/lib/pkgconfig/epoxy.pc

# virglrenderer: the vrend (OpenGL) renderer only. QEMU supplies its GL
# contexts; no EGL, GLX, GBM, DRM, Venus or video paths.
RUN git init -q /virgl && cd /virgl && git fetch -q --depth=1 https://gitlab.freedesktop.org/virgl/virglrenderer.git "$VIRGL_COMMIT" && \
    git checkout -q FETCH_HEAD && python3 /tmp/gpu/patch-virglrenderer.py /virgl && \
    CFLAGS="$CFLAGS -pthread" meson setup _build --cross-file=/gpu-cross.meson --prefix=/glib-emscripten/target \
      --default-library=static --buildtype=release -Dplatforms= -Dvenus=false -Ddrm-renderers= \
      -Dvideo=false -Dtests=false -Dfuzzer=false -Dvalgrind=false -Dtracing=none -Dminigbm_allocation=false && \
    ninja -C _build install

FROM browser-linux-gpu-deps AS browser-linux-gpu-build
ARG WASM_INITIAL_MEMORY_MIB=256
ARG WASM_MAXIMUM_MEMORY_PAGES=65535
RUN python3 /tmp/gpu/patch-qemu-sdl-gl.py /qemu && rm -rf /qemu/build-gpu && mkdir /qemu/build-gpu && cd /qemu/build-gpu && \
    cp -r ../build/node_modules . && \
    EXTRA_CFLAGS="-O3 -g2 -Wno-error=unused-command-line-argument -Wno-error=unused-but-set-variable -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sEXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -sALLOW_TABLE_GROWTH=1 -sINITIAL_MEMORY=$((WASM_INITIAL_MEMORY_MIB*1024*1024)) -sMAXIMUM_MEMORY=$((WASM_MAXIMUM_MEMORY_PAGES*65536)) -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=8388608 -sDEFAULT_PTHREAD_STACK_SIZE=2097152 -sWASM_BIGINT=1 -sMALLOC=emmalloc -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createQemu -sASYNCIFY_IMPORTS=ffi_call_js -sUSE_SDL=2 -sOFFSCREENCANVAS_SUPPORT=1 -sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 -sGL_ENABLE_GET_PROC_ADDRESS=1 $XTERM_PTY_CFLAGS" ; \
    emconfigure ../configure --static --target-list=x86_64-softmmu --cpu=wasm32 --cross-prefix= \
      --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs --enable-sdl --enable-pixman \
      --enable-opengl --enable-virglrenderer \
      --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" \
      --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS,callMain,ENV -lGL -lEGL" && \
    emmake make -j 3 qemu-system-x86_64 && \
    python3 /tmp/gpu/unproxy-egl.py qemu-system-x86_64 && \
    mkdir -p /out-gpu/runtime/vendor /out-gpu/provenance /out-gpu/sources && \
    cp qemu-system-x86_64 /out-gpu/runtime/qemu-system-x86_64.js && \
    cp qemu-system-x86_64.wasm /out-gpu/runtime/ && \
    cp node_modules/xterm-pty/index.js /out-gpu/runtime/vendor/xterm-pty.js && \
    cp -r /tmp/gpu /out-gpu/sources/gpu && \
    printf '{"presenter":"sdl2-webgl2-offscreencanvas","guestGPU":"virtio-gpu-gl (VirGL over WebGL 2)","epoxy":"%s","virglrenderer":"%s"}\n' "$EPOXY_COMMIT" "$VIRGL_COMMIT" > /out-gpu/provenance/graphics.json

FROM scratch AS browser-linux-gpu-runtime
COPY --from=browser-linux-gpu-build /out-gpu/ /
