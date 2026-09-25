#!/usr/bin/env python3
"""Use webgl-compat virtual contexts for QEMU's SDL OpenGL display.

A browser canvas has one WebGL context, so SDL cannot create the shared
contexts virglrenderer asks for. The window's real context stays current;
contexts for the guest renderer become webgl-compat virtual contexts.
"""
import pathlib
import sys

path = pathlib.Path(sys.argv[1]) / "ui" / "sdl2-gl.c"
source = path.read_text()


def replace(old, new, count=1):
    global source
    if source.count(old) != count:
        raise SystemExit(f"QEMU source changed; expected {count} match(es) for:\n{old}")
    source = source.replace(old, new)


# Every place QEMU makes its own window context current (done first, so the
# helper added below keeps its direct SDL call).
window_current = "    SDL_GL_MakeCurrent(scon->real_window, scon->winctx);\n"
sites = source.count(window_current)
if sites < 5:
    raise SystemExit(f"QEMU source changed; found {sites} window-context switches")
replace(window_current, "    SDL_GL_WINDOW_CURRENT(scon);\n", count=sites)

replace('#include "ui/sdl2.h"\n', '''#include "ui/sdl2.h"

#ifdef __EMSCRIPTEN__
int epoxy_webgl_context_create(void);
void epoxy_webgl_context_destroy(int id);
void epoxy_webgl_make_current(int id);

static void sdl2_gl_window_current(struct sdl2_console *scon)
{
    SDL_GL_MakeCurrent(scon->real_window, scon->winctx);
    epoxy_webgl_make_current(0);
}
#define SDL_GL_WINDOW_CURRENT(scon) sdl2_gl_window_current(scon)
#else
#define SDL_GL_WINDOW_CURRENT(scon) SDL_GL_MakeCurrent((scon)->real_window, (scon)->winctx)
#endif
''')

replace("""    ctx = SDL_GL_CreateContext(scon->real_window);

    /* If SDL fail""", """#ifdef __EMSCRIPTEN__
    {
        int id = epoxy_webgl_context_create();
        return id > 0 ? (QEMUGLContext)(intptr_t)id : NULL;
    }
#endif
    ctx = SDL_GL_CreateContext(scon->real_window);

    /* If SDL fail""")

replace("""    SDL_GLContext sdlctx = (SDL_GLContext)ctx;

    SDL_GL_DeleteContext(sdlctx);""", """    SDL_GLContext sdlctx = (SDL_GLContext)ctx;

#ifdef __EMSCRIPTEN__
    epoxy_webgl_context_destroy((int)(intptr_t)ctx);
    return;
#endif
    SDL_GL_DeleteContext(sdlctx);""")

replace("""    assert(scon->opengl);

    return SDL_GL_MakeCurrent(scon->real_window, sdlctx);""", """    assert(scon->opengl);

#ifdef __EMSCRIPTEN__
    if (!ctx) {
        sdl2_gl_window_current(scon);
        return 0;
    }
    SDL_GL_MakeCurrent(scon->real_window, scon->winctx);
    epoxy_webgl_make_current((int)(intptr_t)ctx);
    return 0;
#endif
    return SDL_GL_MakeCurrent(scon->real_window, sdlctx);""")

path.write_text(source)
print(f"patched QEMU SDL OpenGL display for virtual contexts ({sites} window switches)")

# The display renders with WebGL in QEMU's main loop thread. A browser
# presents a worker's OffscreenCanvas, and signals WebGL sync objects (the
# guest's GPU fences), only between tasks, so the main loop must return to the
# event loop regularly. Asyncify suspends the thread while it does.
path = pathlib.Path(sys.argv[1]) / "util" / "qemu-timer.c"
source = path.read_text()
replace("""#define QEMU_EMSCRIPTEN_IDLE_NS 1000000
#endif
""", """#define QEMU_EMSCRIPTEN_IDLE_NS 1000000
#include <emscripten.h>
#include "qemu/coroutine.h"

static void qemu_emscripten_yield(void)
{
    static int64_t last;
    int64_t now = get_clock();

    if (now - last >= 16 * SCALE_MS && !qemu_in_coroutine()) {
        last = now;
        emscripten_sleep(0);
    }
}
#endif
""")
replace("""    int ret = poll((struct pollfd *)fds, nfds, 0);
""", """    qemu_emscripten_yield();
    int ret = poll((struct pollfd *)fds, nfds, 0);
""")
path.write_text(source)
print("QEMU's main loop now yields to the browser about 60 times a second")
