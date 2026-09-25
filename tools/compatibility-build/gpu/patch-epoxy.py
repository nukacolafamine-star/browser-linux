#!/usr/bin/env python3
"""Give libepoxy an Emscripten backend.

Emscripten links its OpenGL ES 3.0 (WebGL 2) and EGL implementations
statically, so nothing can be dlopen()ed. Every symbol lookup goes to
epoxy_webgl_lookup() in webgl-compat.c, which returns Emscripten's WebGL 2
functions, compatibility wrappers for desktop-GL entry points, and the
state-virtualizing wrappers that let several guest GL contexts share the
single WebGL context a canvas provides. Every context is reported as GLES.
"""
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
path = root / "src" / "dispatch_common.c"
source = path.read_text()


def replace(old, new):
    global source
    if source.count(old) != 1:
        raise SystemExit(f"libepoxy source changed; expected one match for:\n{old}")
    source = source.replace(old, new)


# 1. Lookups: no shared libraries exist under Emscripten.
replace("""static bool
get_dlopen_handle(void **handle, const char *lib_name, bool exit_on_fail, bool load)
{""", """#ifdef __EMSCRIPTEN__
void *epoxy_webgl_lookup(const char *name);

static bool
get_dlopen_handle(void **handle, const char *lib_name, bool exit_on_fail, bool load)
{
    (void)lib_name; (void)exit_on_fail; (void)load;
    *handle = (void *)1;
    return true;
}

static void *
do_dlsym(void **handle, const char *name, bool exit_on_fail)
{
    void *result = epoxy_webgl_lookup(name);
    (void)handle;
    if (!result && exit_on_fail) {
        fprintf(stderr, "%s() is not available in WebGL 2\\n", name);
        abort();
    }
    return result;
}
#else
static bool
get_dlopen_handle(void **handle, const char *lib_name, bool exit_on_fail, bool load)
{""")

# Close the #else opened above after the native do_dlsym().
marker = """bool
epoxy_is_desktop_gl(void)
{"""
replace(marker, "#endif /* __EMSCRIPTEN__ */\n\n" + marker + """
#ifdef __EMSCRIPTEN__
    return false;
#endif""")

replace("""void *
epoxy_get_proc_address(const char *name)
{""", """void *
epoxy_get_proc_address(const char *name)
{
#ifdef __EMSCRIPTEN__
    return epoxy_webgl_lookup(name);
#endif""")

replace("""void *
epoxy_get_bootstrap_proc_address(const char *name)
{""", """void *
epoxy_get_bootstrap_proc_address(const char *name)
{
#ifdef __EMSCRIPTEN__
    return epoxy_webgl_lookup(name);
#endif""")

replace("""void *
epoxy_gles2_dlsym(const char *name)
{""", """void *
epoxy_gles2_dlsym(const char *name)
{
#ifdef __EMSCRIPTEN__
    return do_dlsym(&api.gles2_handle, name, true);
#endif""")

replace("""void *
epoxy_gles3_dlsym(const char *name)
{""", """void *
epoxy_gles3_dlsym(const char *name)
{
#ifdef __EMSCRIPTEN__
    return do_dlsym(&api.gles2_handle, name, false);
#endif""")

path.write_text(source)
print("patched libepoxy dispatch for Emscripten")
