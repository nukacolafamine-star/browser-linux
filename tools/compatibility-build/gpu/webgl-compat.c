// SPDX-License-Identifier: MIT
/*
 * OpenGL entry points for libepoxy under Emscripten (see patch-epoxy.py).
 *
 * A browser canvas provides one WebGL 2 context. Native virglrenderer and
 * QEMU expect several GL contexts that share objects but not state: one per
 * guest GL context, plus QEMU's own display context. Objects are naturally
 * shared inside the one WebGL context, so only context *state* needs to be
 * separated. Each virtual context keeps a shadow of the GLES 3.0 context
 * state that virglrenderer and QEMU change; making another virtual context
 * current applies only the state that differs.
 *
 * Desktop-GL-only entry points reachable on GLES code paths get equivalent
 * behavior (glClearDepth, glDepthRange, glMapBufferRange for reading, ...).
 * Everything else resolves to Emscripten's WebGL 2 implementation, or to
 * NULL, which libepoxy reports if a program actually calls it.
 */
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <EGL/egl.h>
#include <emscripten/html5_webgl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* WebGL 2 getBufferSubData, provided by Emscripten; not part of GLES 3.0. */
extern void glGetBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, void *data);

#define MAX_UNITS 32
#define MAX_UBO 72
#define MAX_TFB 4
#define MAX_ATTRIBS 16
#define MAX_CONTEXTS 256

enum { T_2D, T_CUBE, T_3D, T_2D_ARRAY, T_COUNT };

struct indexed_binding {
    GLuint buffer;
    GLintptr offset;
    GLsizeiptr size; /* 0 means glBindBufferBase */
};

struct vstate {
    bool used;
    /* capabilities */
    bool blend, cull_face, depth_test, dither, polygon_offset_fill, primitive_restart,
         rasterizer_discard, sample_alpha_to_coverage, sample_coverage, scissor_test, stencil_test;
    GLfloat blend_color[4];
    GLenum blend_eq_rgb, blend_eq_alpha, blend_src_rgb, blend_dst_rgb, blend_src_alpha, blend_dst_alpha;
    GLboolean color_mask[4], depth_mask;
    GLfloat clear_color[4], clear_depth;
    GLint clear_stencil;
    GLenum depth_func, cull_mode, front_face;
    GLfloat depth_near, depth_far, line_width, polygon_factor, polygon_units, coverage_value;
    GLboolean coverage_invert;
    GLenum stencil_func[2], stencil_fail[2], stencil_zfail[2], stencil_zpass[2];
    GLint stencil_ref[2];
    GLuint stencil_value_mask[2], stencil_write_mask[2];
    GLint scissor[4], viewport[4];
    GLint pack_alignment, unpack_alignment, pack_row_length, pack_skip_pixels, pack_skip_rows,
          unpack_row_length, unpack_image_height, unpack_skip_pixels, unpack_skip_rows, unpack_skip_images;
    GLenum hint_mipmap, hint_derivative;
    GLuint array_buffer, copy_read_buffer, copy_write_buffer, pixel_pack_buffer, pixel_unpack_buffer,
           uniform_buffer, transform_feedback_buffer;
    struct indexed_binding ubo[MAX_UBO], tfb[MAX_TFB];
    GLuint vertex_array, transform_feedback, draw_framebuffer, read_framebuffer, renderbuffer, program;
    GLenum active_texture;
    GLuint textures[MAX_UNITS][T_COUNT], samplers[MAX_UNITS];
    int max_unit; /* highest unit index with a binding, or -1 */
    /* current generic vertex attribute values */
    GLenum attrib_type[MAX_ATTRIBS]; /* GL_FLOAT, GL_INT or GL_UNSIGNED_INT */
    union { GLfloat f[4]; GLint i[4]; GLuint u[4]; } attrib[MAX_ATTRIBS];
};

static struct vstate *contexts[MAX_CONTEXTS];
static int current_id;

static void init_state(struct vstate *s)
{
    memset(s, 0, sizeof(*s));
    s->used = true;
    s->dither = true;
    s->blend_eq_rgb = s->blend_eq_alpha = GL_FUNC_ADD;
    s->blend_src_rgb = s->blend_src_alpha = GL_ONE;
    s->blend_dst_rgb = s->blend_dst_alpha = GL_ZERO;
    for (int i = 0; i < 4; i++) s->color_mask[i] = GL_TRUE;
    s->depth_mask = GL_TRUE;
    s->clear_depth = 1.0f;
    s->depth_func = GL_LESS;
    s->cull_mode = GL_BACK;
    s->front_face = GL_CCW;
    s->depth_far = 1.0f;
    s->line_width = 1.0f;
    s->coverage_value = 1.0f;
    for (int face = 0; face < 2; face++) {
        s->stencil_func[face] = GL_ALWAYS;
        s->stencil_fail[face] = s->stencil_zfail[face] = s->stencil_zpass[face] = GL_KEEP;
        s->stencil_value_mask[face] = s->stencil_write_mask[face] = ~0u;
    }
    s->pack_alignment = s->unpack_alignment = 4;
    s->hint_mipmap = s->hint_derivative = GL_DONT_CARE;
    s->active_texture = GL_TEXTURE0;
    s->max_unit = -1;
    for (int i = 0; i < MAX_ATTRIBS; i++) {
        s->attrib_type[i] = GL_FLOAT;
        s->attrib[i].f[3] = 1.0f;
    }
}

static struct vstate *cur(void)
{
    if (!contexts[current_id]) {
        contexts[current_id] = malloc(sizeof(struct vstate));
        init_state(contexts[current_id]);
        /* The window's initial viewport and scissor box cover the canvas. */
        GLint viewport[4];
        glGetIntegerv(GL_VIEWPORT, viewport);
        memcpy(contexts[current_id]->viewport, viewport, sizeof(viewport));
        memcpy(contexts[current_id]->scissor, viewport, sizeof(viewport));
    }
    return contexts[current_id];
}

static int texture_target_index(GLenum target)
{
    switch (target) {
    case GL_TEXTURE_2D: return T_2D;
    case GL_TEXTURE_CUBE_MAP: return T_CUBE;
    case GL_TEXTURE_3D: return T_3D;
    case GL_TEXTURE_2D_ARRAY: return T_2D_ARRAY;
    default: return -1;
    }
}
static const GLenum texture_targets[T_COUNT] = {GL_TEXTURE_2D, GL_TEXTURE_CUBE_MAP, GL_TEXTURE_3D, GL_TEXTURE_2D_ARRAY};

static bool *capability(struct vstate *s, GLenum cap)
{
    switch (cap) {
    case GL_BLEND: return &s->blend;
    case GL_CULL_FACE: return &s->cull_face;
    case GL_DEPTH_TEST: return &s->depth_test;
    case GL_DITHER: return &s->dither;
    case GL_POLYGON_OFFSET_FILL: return &s->polygon_offset_fill;
    case GL_PRIMITIVE_RESTART_FIXED_INDEX: return &s->primitive_restart;
    case GL_RASTERIZER_DISCARD: return &s->rasterizer_discard;
    case GL_SAMPLE_ALPHA_TO_COVERAGE: return &s->sample_alpha_to_coverage;
    case GL_SAMPLE_COVERAGE: return &s->sample_coverage;
    case GL_SCISSOR_TEST: return &s->scissor_test;
    case GL_STENCIL_TEST: return &s->stencil_test;
    default: return NULL;
    }
}
/* The capabilities WebGL 2 can switch. Primitive restart with the fixed
 * index is always on in WebGL 2; desktop-only capabilities do not exist. */
static const GLenum capabilities[] = {
    GL_BLEND, GL_CULL_FACE, GL_DEPTH_TEST, GL_DITHER, GL_POLYGON_OFFSET_FILL,
    GL_RASTERIZER_DISCARD, GL_SAMPLE_ALPHA_TO_COVERAGE,
    GL_SAMPLE_COVERAGE, GL_SCISSOR_TEST, GL_STENCIL_TEST,
};
static bool webgl_capability(GLenum cap)
{
    for (size_t i = 0; i < sizeof(capabilities) / sizeof(capabilities[0]); i++)
        if (capabilities[i] == cap) return true;
    return false;
}

static GLuint *buffer_binding(struct vstate *s, GLenum target)
{
    switch (target) {
    case GL_ARRAY_BUFFER: return &s->array_buffer;
    case GL_COPY_READ_BUFFER: return &s->copy_read_buffer;
    case GL_COPY_WRITE_BUFFER: return &s->copy_write_buffer;
    case GL_PIXEL_PACK_BUFFER: return &s->pixel_pack_buffer;
    case GL_PIXEL_UNPACK_BUFFER: return &s->pixel_unpack_buffer;
    case GL_UNIFORM_BUFFER: return &s->uniform_buffer;
    case GL_TRANSFORM_FEEDBACK_BUFFER: return &s->transform_feedback_buffer;
    default: return NULL; /* GL_ELEMENT_ARRAY_BUFFER belongs to the vertex array */
    }
}

static GLint *pixel_store(struct vstate *s, GLenum pname)
{
    switch (pname) {
    case GL_PACK_ALIGNMENT: return &s->pack_alignment;
    case GL_UNPACK_ALIGNMENT: return &s->unpack_alignment;
    case GL_PACK_ROW_LENGTH: return &s->pack_row_length;
    case GL_PACK_SKIP_PIXELS: return &s->pack_skip_pixels;
    case GL_PACK_SKIP_ROWS: return &s->pack_skip_rows;
    case GL_UNPACK_ROW_LENGTH: return &s->unpack_row_length;
    case GL_UNPACK_IMAGE_HEIGHT: return &s->unpack_image_height;
    case GL_UNPACK_SKIP_PIXELS: return &s->unpack_skip_pixels;
    case GL_UNPACK_SKIP_ROWS: return &s->unpack_skip_rows;
    case GL_UNPACK_SKIP_IMAGES: return &s->unpack_skip_images;
    default: return NULL;
    }
}
static const GLenum pixel_stores[] = {
    GL_PACK_ALIGNMENT, GL_UNPACK_ALIGNMENT, GL_PACK_ROW_LENGTH, GL_PACK_SKIP_PIXELS, GL_PACK_SKIP_ROWS,
    GL_UNPACK_ROW_LENGTH, GL_UNPACK_IMAGE_HEIGHT, GL_UNPACK_SKIP_PIXELS, GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_IMAGES,
};

/* ---------------------------------------------------------------------- */
/* Buffers                                                                  */
/*
 * WebGL fixes a buffer's type at its first binding: element (index) buffers
 * and all other buffers cannot share a buffer object or be copied into each
 * other on the GPU. virglrenderer binds one guest buffer for both (Mesa
 * uploads vertices and indices into the same buffer). Every buffer is
 * therefore created as a non-element buffer; binding one as the element
 * array binds an element-typed twin instead, which is refreshed from a CPU
 * copy of the buffer's contents before indexed draws.
 */
struct buffer {
    GLuint twin;                    /* element-array twin, 0 until needed */
    uint8_t *shadow;                /* CPU copy, kept once a twin exists */
    GLsizeiptr size;
    GLsizeiptr dirty_lo, dirty_hi;  /* the twin is stale in [dirty_lo, dirty_hi) */
    bool gpu_written;               /* the stale range of the shadow came from the GPU */
    bool twin_sized;                /* the twin has storage of the current size */
};
static struct buffer *buffers;
static GLuint buffers_len;
static GLuint *vao_elements;        /* element buffer (its real name) per vertex array */
static GLuint vao_elements_len;

static void *grow(void *array, GLuint *len, GLuint index, size_t item)
{
    if (index < *len) return array;
    GLuint wanted = index * 2 + 64;
    char *grown = realloc(array, wanted * item);
    if (!grown) return NULL;
    memset(grown + *len * item, 0, (wanted - *len) * item);
    *len = wanted;
    return grown;
}
static struct buffer *buffer_info(GLuint name)
{
    if (!name) return NULL;
    struct buffer *grown = grow(buffers, &buffers_len, name, sizeof(*buffers));
    if (!grown) return NULL;
    buffers = grown;
    return &buffers[name];
}
static GLuint *vao_element(GLuint vao)
{
    GLuint *grown = grow(vao_elements, &vao_elements_len, vao, sizeof(*vao_elements));
    if (!grown) return NULL;
    vao_elements = grown;
    return &vao_elements[vao];
}

/* The buffer (by its own name, never a twin's) bound to a target. */
static GLuint target_buffer(GLenum target)
{
    struct vstate *s = cur();
    if (target == GL_ELEMENT_ARRAY_BUFFER) {
        GLuint *element = vao_element(s->vertex_array);
        return element ? *element : 0;
    }
    GLuint *binding = buffer_binding(s, target);
    return binding ? *binding : 0;
}

/* Reads and writes a buffer through a copy binding, then restores it. */
static void read_buffer(GLuint name, GLintptr offset, GLsizeiptr size, void *out)
{
    struct buffer *b = buffer_info(name);
    if (b && b->shadow && !(b->gpu_written && offset < b->dirty_hi && offset + size > b->dirty_lo) &&
        offset >= 0 && offset + size <= b->size) {
        memcpy(out, b->shadow + offset, (size_t)size);
        return;
    }
    glBindBuffer(GL_COPY_READ_BUFFER, name);
    glGetBufferSubData(GL_COPY_READ_BUFFER, offset, size, out);
    glBindBuffer(GL_COPY_READ_BUFFER, cur()->copy_read_buffer);
}

/* Keeps the shadow of a buffer that has a twin up to date. NULL data: the
 * range was written on the GPU and is read back when it is next needed. */
static void buffer_written(GLuint name, GLintptr offset, GLsizeiptr size, const void *data)
{
    struct buffer *b = buffer_info(name);
    if (!b || !b->shadow || size <= 0 || offset < 0 || offset + size > b->size) return;
    if (data) memcpy(b->shadow + offset, data, (size_t)size);
    else b->gpu_written = true;
    if (b->dirty_hi <= b->dirty_lo) { b->dirty_lo = offset; b->dirty_hi = offset + size; }
    else {
        if (offset < b->dirty_lo) b->dirty_lo = offset;
        if (offset + size > b->dirty_hi) b->dirty_hi = offset + size;
    }
}

static void write_buffer(GLuint name, GLintptr offset, GLsizeiptr size, const void *data)
{
    glBindBuffer(GL_COPY_WRITE_BUFFER, name);
    glBufferSubData(GL_COPY_WRITE_BUFFER, offset, size, data);
    glBindBuffer(GL_COPY_WRITE_BUFFER, cur()->copy_write_buffer);
    buffer_written(name, offset, size, data);
}

static GLuint element_twin(GLuint name)
{
    struct buffer *b = buffer_info(name);
    if (!b) return name;
    if (!b->twin) {
        uint8_t *shadow = malloc(b->size > 0 ? (size_t)b->size : 1);
        if (!shadow) return name;
        if (b->size > 0) read_buffer(name, 0, b->size, shadow);
        glGenBuffers(1, &b->twin);
        b->shadow = shadow;
        b->twin_sized = false;
        b->gpu_written = false;
        b->dirty_lo = 0; b->dirty_hi = b->size;
    }
    return b->twin;
}

/* Brings the bound element-array twin up to date before an indexed draw. */
static void refresh_element_twin(void)
{
    GLuint name = target_buffer(GL_ELEMENT_ARRAY_BUFFER);
    struct buffer *b = buffer_info(name);
    if (!b || !b->twin) return;
    if (b->gpu_written && b->dirty_hi > b->dirty_lo) {
        glBindBuffer(GL_COPY_READ_BUFFER, name);
        glGetBufferSubData(GL_COPY_READ_BUFFER, b->dirty_lo, b->dirty_hi - b->dirty_lo, b->shadow + b->dirty_lo);
        glBindBuffer(GL_COPY_READ_BUFFER, cur()->copy_read_buffer);
    }
    b->gpu_written = false;
    if (!b->twin_sized) {
        glBufferData(GL_ELEMENT_ARRAY_BUFFER, b->size, b->shadow, GL_DYNAMIC_DRAW);
        b->twin_sized = true;
    } else if (b->dirty_hi > b->dirty_lo) {
        glBufferSubData(GL_ELEMENT_ARRAY_BUFFER, b->dirty_lo, b->dirty_hi - b->dirty_lo, b->shadow + b->dirty_lo);
    }
    b->dirty_lo = b->dirty_hi = 0;
}

static void vc_GenBuffers(GLsizei n, GLuint *names)
{
    glGenBuffers(n, names);
    /* The first binding makes each a non-element buffer (see above). */
    for (GLsizei i = 0; i < n; i++) {
        glBindBuffer(GL_COPY_WRITE_BUFFER, names[i]);
        struct buffer *b = buffer_info(names[i]);
        if (b) memset(b, 0, sizeof(*b));
    }
    glBindBuffer(GL_COPY_WRITE_BUFFER, cur()->copy_write_buffer);
}

static void vc_BufferData(GLenum target, GLsizeiptr size, const void *data, GLenum usage)
{
    GLuint name = target_buffer(target);
    if (target == GL_ELEMENT_ARRAY_BUFFER) {
        glBindBuffer(GL_COPY_WRITE_BUFFER, name);
        glBufferData(GL_COPY_WRITE_BUFFER, size, data, usage);
        glBindBuffer(GL_COPY_WRITE_BUFFER, cur()->copy_write_buffer);
    } else {
        glBufferData(target, size, data, usage);
    }
    struct buffer *b = buffer_info(name);
    if (!b || size < 0) return;
    b->size = size;
    if (b->shadow) {
        uint8_t *shadow = realloc(b->shadow, size > 0 ? (size_t)size : 1);
        if (!shadow) return;
        b->shadow = shadow;
        if (data) memcpy(shadow, data, (size_t)size); else memset(shadow, 0, (size_t)size);
        b->twin_sized = false;
        b->gpu_written = false;
        b->dirty_lo = 0; b->dirty_hi = size;
    }
}

static void vc_BufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void *data)
{
    if (target == GL_ELEMENT_ARRAY_BUFFER) {
        write_buffer(target_buffer(target), offset, size, data);
        return;
    }
    glBufferSubData(target, offset, size, data);
    buffer_written(target_buffer(target), offset, size, data);
}

static void vc_CopyBufferSubData(GLenum read_target, GLenum write_target, GLintptr read_offset,
                                 GLintptr write_offset, GLsizeiptr size)
{
    GLuint source = target_buffer(read_target), destination = target_buffer(write_target);
    glBindBuffer(GL_COPY_READ_BUFFER, source);
    glBindBuffer(GL_COPY_WRITE_BUFFER, destination);
    glCopyBufferSubData(GL_COPY_READ_BUFFER, GL_COPY_WRITE_BUFFER, read_offset, write_offset, size);
    glBindBuffer(GL_COPY_READ_BUFFER, cur()->copy_read_buffer);
    glBindBuffer(GL_COPY_WRITE_BUFFER, cur()->copy_write_buffer);
    /* Grow the table once, so that neither pointer is moved by the other lookup. */
    buffer_info(source > destination ? source : destination);
    struct buffer *d = buffer_info(destination), *s = buffer_info(source);
    if (d && d->shadow) {
        if (s && s->shadow && !s->gpu_written && read_offset >= 0 && read_offset + size <= s->size)
            buffer_written(destination, write_offset, size, s->shadow + read_offset);
        else
            buffer_written(destination, write_offset, size, NULL);
    }
}

static void vc_GetBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, void *data)
{
    read_buffer(target_buffer(target), offset, size, data);
}

static void forget_buffer(GLuint name)
{
    struct buffer *b = buffer_info(name);
    if (!b) return;
    if (b->twin) glDeleteBuffers(1, &b->twin);
    free(b->shadow);
    memset(b, 0, sizeof(*b));
    for (GLuint i = 0; i < vao_elements_len; i++) if (vao_elements[i] == name) vao_elements[i] = 0;
}

static void vc_DrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices)
{ refresh_element_twin(); glDrawElements(mode, count, type, indices); }
static void vc_DrawElementsInstanced(GLenum mode, GLsizei count, GLenum type, const void *indices, GLsizei instances)
{ refresh_element_twin(); glDrawElementsInstanced(mode, count, type, indices, instances); }
static void vc_DrawRangeElements(GLenum mode, GLuint start, GLuint end, GLsizei count, GLenum type, const void *indices)
{ refresh_element_twin(); glDrawRangeElements(mode, start, end, count, type, indices); }

/* The GPU writes these buffers; their shadows are refreshed when needed. */
static void vc_EndTransformFeedback(void)
{
    glEndTransformFeedback();
    struct vstate *s = cur();
    for (int i = 0; i < MAX_TFB; i++) {
        struct buffer *b = buffer_info(s->tfb[i].buffer);
        if (b && b->shadow) buffer_written(s->tfb[i].buffer, 0, b->size, NULL);
    }
}
static void vc_ReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void *pixels)
{
    glReadPixels(x, y, width, height, format, type, pixels);
    struct buffer *b = buffer_info(cur()->pixel_pack_buffer);
    if (b && b->shadow) buffer_written(cur()->pixel_pack_buffer, 0, b->size, NULL);
}

/* ---------------------------------------------------------------------- */
/* State-tracking wrappers                                                 */

static void vc_Enable(GLenum cap) { bool *v = capability(cur(), cap); if (v) *v = true; if (webgl_capability(cap)) glEnable(cap); }
static void vc_Disable(GLenum cap) { bool *v = capability(cur(), cap); if (v) *v = false; if (webgl_capability(cap)) glDisable(cap); }
static void vc_BlendColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a)
{ struct vstate *s = cur(); s->blend_color[0] = r; s->blend_color[1] = g; s->blend_color[2] = b; s->blend_color[3] = a; glBlendColor(r, g, b, a); }
static void vc_BlendEquation(GLenum mode) { struct vstate *s = cur(); s->blend_eq_rgb = s->blend_eq_alpha = mode; glBlendEquation(mode); }
static void vc_BlendEquationSeparate(GLenum rgb, GLenum alpha) { struct vstate *s = cur(); s->blend_eq_rgb = rgb; s->blend_eq_alpha = alpha; glBlendEquationSeparate(rgb, alpha); }
static void vc_BlendFunc(GLenum src, GLenum dst)
{ struct vstate *s = cur(); s->blend_src_rgb = s->blend_src_alpha = src; s->blend_dst_rgb = s->blend_dst_alpha = dst; glBlendFunc(src, dst); }
static void vc_BlendFuncSeparate(GLenum srgb, GLenum drgb, GLenum sa, GLenum da)
{ struct vstate *s = cur(); s->blend_src_rgb = srgb; s->blend_dst_rgb = drgb; s->blend_src_alpha = sa; s->blend_dst_alpha = da; glBlendFuncSeparate(srgb, drgb, sa, da); }
static void vc_ColorMask(GLboolean r, GLboolean g, GLboolean b, GLboolean a)
{ struct vstate *s = cur(); s->color_mask[0] = r; s->color_mask[1] = g; s->color_mask[2] = b; s->color_mask[3] = a; glColorMask(r, g, b, a); }
static void vc_DepthMask(GLboolean flag) { cur()->depth_mask = flag; glDepthMask(flag); }
static void vc_StencilMask(GLuint mask) { struct vstate *s = cur(); s->stencil_write_mask[0] = s->stencil_write_mask[1] = mask; glStencilMask(mask); }
static void vc_StencilMaskSeparate(GLenum face, GLuint mask)
{ struct vstate *s = cur(); if (face != GL_BACK) s->stencil_write_mask[0] = mask; if (face != GL_FRONT) s->stencil_write_mask[1] = mask; glStencilMaskSeparate(face, mask); }
static void vc_ClearColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a)
{ struct vstate *s = cur(); s->clear_color[0] = r; s->clear_color[1] = g; s->clear_color[2] = b; s->clear_color[3] = a; glClearColor(r, g, b, a); }
static void vc_ClearDepthf(GLfloat d) { cur()->clear_depth = d; glClearDepthf(d); }
static void vc_ClearDepth(double d) { vc_ClearDepthf((GLfloat)d); }
static void vc_ClearStencil(GLint s) { cur()->clear_stencil = s; glClearStencil(s); }
static void vc_DepthFunc(GLenum func) { cur()->depth_func = func; glDepthFunc(func); }
static void vc_DepthRangef(GLfloat n, GLfloat f) { struct vstate *s = cur(); s->depth_near = n; s->depth_far = f; glDepthRangef(n, f); }
static void vc_DepthRange(double n, double f) { vc_DepthRangef((GLfloat)n, (GLfloat)f); }
static void vc_CullFace(GLenum mode) { cur()->cull_mode = mode; glCullFace(mode); }
static void vc_FrontFace(GLenum mode) { cur()->front_face = mode; glFrontFace(mode); }
static void vc_LineWidth(GLfloat width) { cur()->line_width = width; glLineWidth(width); }
static void vc_PolygonOffset(GLfloat factor, GLfloat units) { struct vstate *s = cur(); s->polygon_factor = factor; s->polygon_units = units; glPolygonOffset(factor, units); }
static void vc_SampleCoverage(GLfloat value, GLboolean invert) { struct vstate *s = cur(); s->coverage_value = value; s->coverage_invert = invert; glSampleCoverage(value, invert); }
static void vc_StencilFuncSeparate(GLenum face, GLenum func, GLint ref, GLuint mask)
{
    struct vstate *s = cur();
    for (int f = 0; f < 2; f++) {
        if ((f == 0 && face == GL_BACK) || (f == 1 && face == GL_FRONT)) continue;
        s->stencil_func[f] = func; s->stencil_ref[f] = ref; s->stencil_value_mask[f] = mask;
    }
    glStencilFuncSeparate(face, func, ref, mask);
}
static void vc_StencilFunc(GLenum func, GLint ref, GLuint mask) { vc_StencilFuncSeparate(GL_FRONT_AND_BACK, func, ref, mask); }
static void vc_StencilOpSeparate(GLenum face, GLenum fail, GLenum zfail, GLenum zpass)
{
    struct vstate *s = cur();
    for (int f = 0; f < 2; f++) {
        if ((f == 0 && face == GL_BACK) || (f == 1 && face == GL_FRONT)) continue;
        s->stencil_fail[f] = fail; s->stencil_zfail[f] = zfail; s->stencil_zpass[f] = zpass;
    }
    glStencilOpSeparate(face, fail, zfail, zpass);
}
static void vc_StencilOp(GLenum fail, GLenum zfail, GLenum zpass) { vc_StencilOpSeparate(GL_FRONT_AND_BACK, fail, zfail, zpass); }
static void vc_Scissor(GLint x, GLint y, GLsizei w, GLsizei h)
{ struct vstate *s = cur(); s->scissor[0] = x; s->scissor[1] = y; s->scissor[2] = w; s->scissor[3] = h; glScissor(x, y, w, h); }
static void vc_Viewport(GLint x, GLint y, GLsizei w, GLsizei h)
{ struct vstate *s = cur(); s->viewport[0] = x; s->viewport[1] = y; s->viewport[2] = w; s->viewport[3] = h; glViewport(x, y, w, h); }
static void vc_PixelStorei(GLenum pname, GLint param) { GLint *v = pixel_store(cur(), pname); if (v) *v = param; glPixelStorei(pname, param); }
static void vc_Hint(GLenum target, GLenum mode)
{
    struct vstate *s = cur();
    if (target == GL_GENERATE_MIPMAP_HINT) s->hint_mipmap = mode;
    else if (target == GL_FRAGMENT_SHADER_DERIVATIVE_HINT) s->hint_derivative = mode;
    glHint(target, mode);
}

static void vc_BindBuffer(GLenum target, GLuint buffer)
{
    struct vstate *s = cur();
    if (target == GL_ELEMENT_ARRAY_BUFFER) {
        GLuint *element = vao_element(s->vertex_array);
        if (element) *element = buffer;
        glBindBuffer(target, buffer ? element_twin(buffer) : 0);
        return;
    }
    GLuint *binding = buffer_binding(s, target);
    if (binding) *binding = buffer;
    glBindBuffer(target, buffer);
}
static struct indexed_binding *indexed(struct vstate *s, GLenum target, GLuint index)
{
    if (target == GL_UNIFORM_BUFFER && index < MAX_UBO) return &s->ubo[index];
    if (target == GL_TRANSFORM_FEEDBACK_BUFFER && index < MAX_TFB) return &s->tfb[index];
    return NULL;
}
static void vc_BindBufferBase(GLenum target, GLuint index, GLuint buffer)
{
    struct vstate *s = cur();
    struct indexed_binding *b = indexed(s, target, index);
    if (b) { b->buffer = buffer; b->offset = 0; b->size = 0; }
    GLuint *generic = buffer_binding(s, target);
    if (generic) *generic = buffer; /* also sets the generic binding */
    glBindBufferBase(target, index, buffer);
}
static void vc_BindBufferRange(GLenum target, GLuint index, GLuint buffer, GLintptr offset, GLsizeiptr size)
{
    struct vstate *s = cur();
    struct indexed_binding *b = indexed(s, target, index);
    if (b) { b->buffer = buffer; b->offset = offset; b->size = size; }
    GLuint *generic = buffer_binding(s, target);
    if (generic) *generic = buffer;
    glBindBufferRange(target, index, buffer, offset, size);
}
static void vc_BindVertexArray(GLuint array) { cur()->vertex_array = array; glBindVertexArray(array); }
static void vc_BindFramebuffer(GLenum target, GLuint framebuffer)
{
    struct vstate *s = cur();
    if (target == GL_FRAMEBUFFER || target == GL_DRAW_FRAMEBUFFER) s->draw_framebuffer = framebuffer;
    if (target == GL_FRAMEBUFFER || target == GL_READ_FRAMEBUFFER) s->read_framebuffer = framebuffer;
    glBindFramebuffer(target, framebuffer);
}
static void vc_BindRenderbuffer(GLenum target, GLuint renderbuffer) { cur()->renderbuffer = renderbuffer; glBindRenderbuffer(target, renderbuffer); }
static void vc_ActiveTexture(GLenum texture) { cur()->active_texture = texture; glActiveTexture(texture); }
static void vc_BindTexture(GLenum target, GLuint texture)
{
    struct vstate *s = cur();
    int unit = (int)(s->active_texture - GL_TEXTURE0), index = texture_target_index(target);
    if (unit >= 0 && unit < MAX_UNITS && index >= 0) {
        s->textures[unit][index] = texture;
        if (unit > s->max_unit) s->max_unit = unit;
    }
    glBindTexture(target, texture);
}
static void vc_BindSampler(GLuint unit, GLuint sampler)
{
    struct vstate *s = cur();
    if (unit < MAX_UNITS) { s->samplers[unit] = sampler; if ((int)unit > s->max_unit) s->max_unit = unit; }
    glBindSampler(unit, sampler);
}
static void vc_UseProgram(GLuint program) { cur()->program = program; glUseProgram(program); }
static void vc_BindTransformFeedback(GLenum target, GLuint id) { cur()->transform_feedback = id; glBindTransformFeedback(target, id); }

static void set_attrib_f(GLuint index, GLfloat x, GLfloat y, GLfloat z, GLfloat w)
{
    if (index >= MAX_ATTRIBS) return;
    struct vstate *s = cur();
    s->attrib_type[index] = GL_FLOAT;
    s->attrib[index].f[0] = x; s->attrib[index].f[1] = y; s->attrib[index].f[2] = z; s->attrib[index].f[3] = w;
}
static void vc_VertexAttrib1f(GLuint i, GLfloat x) { set_attrib_f(i, x, 0, 0, 1); glVertexAttrib1f(i, x); }
static void vc_VertexAttrib2f(GLuint i, GLfloat x, GLfloat y) { set_attrib_f(i, x, y, 0, 1); glVertexAttrib2f(i, x, y); }
static void vc_VertexAttrib3f(GLuint i, GLfloat x, GLfloat y, GLfloat z) { set_attrib_f(i, x, y, z, 1); glVertexAttrib3f(i, x, y, z); }
static void vc_VertexAttrib4f(GLuint i, GLfloat x, GLfloat y, GLfloat z, GLfloat w) { set_attrib_f(i, x, y, z, w); glVertexAttrib4f(i, x, y, z, w); }
static void vc_VertexAttrib1fv(GLuint i, const GLfloat *v) { set_attrib_f(i, v[0], 0, 0, 1); glVertexAttrib1fv(i, v); }
static void vc_VertexAttrib2fv(GLuint i, const GLfloat *v) { set_attrib_f(i, v[0], v[1], 0, 1); glVertexAttrib2fv(i, v); }
static void vc_VertexAttrib3fv(GLuint i, const GLfloat *v) { set_attrib_f(i, v[0], v[1], v[2], 1); glVertexAttrib3fv(i, v); }
static void vc_VertexAttrib4fv(GLuint i, const GLfloat *v) { set_attrib_f(i, v[0], v[1], v[2], v[3]); glVertexAttrib4fv(i, v); }
static void vc_VertexAttribI4i(GLuint i, GLint x, GLint y, GLint z, GLint w)
{
    if (i < MAX_ATTRIBS) { struct vstate *s = cur(); s->attrib_type[i] = GL_INT; s->attrib[i].i[0] = x; s->attrib[i].i[1] = y; s->attrib[i].i[2] = z; s->attrib[i].i[3] = w; }
    glVertexAttribI4i(i, x, y, z, w);
}
static void vc_VertexAttribI4ui(GLuint i, GLuint x, GLuint y, GLuint z, GLuint w)
{
    if (i < MAX_ATTRIBS) { struct vstate *s = cur(); s->attrib_type[i] = GL_UNSIGNED_INT; s->attrib[i].u[0] = x; s->attrib[i].u[1] = y; s->attrib[i].u[2] = z; s->attrib[i].u[3] = w; }
    glVertexAttribI4ui(i, x, y, z, w);
}
static void vc_VertexAttribI4iv(GLuint i, const GLint *v) { vc_VertexAttribI4i(i, v[0], v[1], v[2], v[3]); }
static void vc_VertexAttribI4uiv(GLuint i, const GLuint *v) { vc_VertexAttribI4ui(i, v[0], v[1], v[2], v[3]); }

/* Deleting a bound object unbinds it from the current context. */
static void forget(GLuint *binding, const GLuint *names, GLsizei n)
{
    for (GLsizei i = 0; i < n; i++) if (names[i] && *binding == names[i]) *binding = 0;
}
static void vc_DeleteBuffers(GLsizei n, const GLuint *names)
{
    struct vstate *s = cur();
    forget(&s->array_buffer, names, n); forget(&s->copy_read_buffer, names, n); forget(&s->copy_write_buffer, names, n);
    forget(&s->pixel_pack_buffer, names, n); forget(&s->pixel_unpack_buffer, names, n);
    forget(&s->uniform_buffer, names, n); forget(&s->transform_feedback_buffer, names, n);
    for (int i = 0; i < MAX_UBO; i++) forget(&s->ubo[i].buffer, names, n);
    for (int i = 0; i < MAX_TFB; i++) forget(&s->tfb[i].buffer, names, n);
    for (GLsizei i = 0; i < n; i++) forget_buffer(names[i]);
    glDeleteBuffers(n, names);
}
static void vc_DeleteTextures(GLsizei n, const GLuint *names)
{
    struct vstate *s = cur();
    for (int u = 0; u <= s->max_unit; u++) for (int t = 0; t < T_COUNT; t++) forget(&s->textures[u][t], names, n);
    glDeleteTextures(n, names);
}
static void vc_DeleteSamplers(GLsizei n, const GLuint *names)
{
    struct vstate *s = cur();
    for (int u = 0; u <= s->max_unit; u++) forget(&s->samplers[u], names, n);
    glDeleteSamplers(n, names);
}
static void vc_DeleteFramebuffers(GLsizei n, const GLuint *names)
{
    struct vstate *s = cur();
    forget(&s->draw_framebuffer, names, n); forget(&s->read_framebuffer, names, n);
    glDeleteFramebuffers(n, names);
}
static void vc_DeleteRenderbuffers(GLsizei n, const GLuint *names) { forget(&cur()->renderbuffer, names, n); glDeleteRenderbuffers(n, names); }
static void vc_DeleteVertexArrays(GLsizei n, const GLuint *names)
{
    forget(&cur()->vertex_array, names, n);
    for (GLsizei i = 0; i < n; i++) if (names[i] < vao_elements_len) vao_elements[names[i]] = 0;
    glDeleteVertexArrays(n, names);
}
static void vc_DeleteTransformFeedbacks(GLsizei n, const GLuint *names) { forget(&cur()->transform_feedback, names, n); glDeleteTransformFeedbacks(n, names); }
static void vc_DeleteProgram(GLuint program) { if (cur()->program == program) { /* stays in use until replaced, as in GL */ } glDeleteProgram(program); }

/* ---------------------------------------------------------------------- */
/* Buffer mapping. WebGL has no mapping; emulate it with a client copy.     */

struct mapping {
    GLuint buffer;
    void *data;
    GLintptr offset;
    GLsizeiptr length;
    GLbitfield access;
    struct mapping *next;
};
static struct mapping *mappings;

static struct mapping **find_mapping(GLuint buffer)
{
    struct mapping **m = &mappings;
    while (*m && (*m)->buffer != buffer) m = &(*m)->next;
    return m;
}
static void *vc_MapBufferRange(GLenum target, GLintptr offset, GLsizeiptr length, GLbitfield access)
{
    GLuint buffer = target_buffer(target);
    if (!buffer || length <= 0 || *find_mapping(buffer)) return NULL;
    struct mapping *m = calloc(1, sizeof(*m));
    if (!m) return NULL;
    m->data = malloc((size_t)length);
    if (!m->data) { free(m); return NULL; }
    m->buffer = buffer; m->offset = offset; m->length = length; m->access = access;
    if ((access & GL_MAP_READ_BIT) || !(access & (GL_MAP_INVALIDATE_RANGE_BIT | GL_MAP_INVALIDATE_BUFFER_BIT))) {
        /* Partial writes must keep the bytes they do not overwrite. */
        read_buffer(buffer, offset, length, m->data);
    }
    m->next = mappings; mappings = m;
    return m->data;
}
static void vc_FlushMappedBufferRange(GLenum target, GLintptr offset, GLsizeiptr length)
{
    struct mapping *m = *find_mapping(target_buffer(target));
    if (m && (m->access & GL_MAP_WRITE_BIT) && offset >= 0 && offset + length <= m->length)
        write_buffer(m->buffer, m->offset + offset, length, (const char *)m->data + offset);
}
static GLboolean vc_UnmapBuffer(GLenum target)
{
    struct mapping **slot = find_mapping(target_buffer(target)), *m = *slot;
    if (!m) return GL_FALSE;
    if ((m->access & GL_MAP_WRITE_BIT) && !(m->access & GL_MAP_FLUSH_EXPLICIT_BIT))
        write_buffer(m->buffer, m->offset, m->length, m->data);
    *slot = m->next;
    free(m->data); free(m);
    return GL_TRUE;
}

/* ---------------------------------------------------------------------- */
/* Desktop GL entry points with a GLES equivalent, or none that matters.   */

static void warn_once(const char *what)
{
    static char warned[64][48];
    for (int i = 0; i < 64; i++) {
        if (!warned[i][0]) { snprintf(warned[i], sizeof(warned[i]), "%s", what); fprintf(stderr, "webgl-compat: %s is not supported by WebGL 2; ignored\n", what); return; }
        if (!strcmp(warned[i], what)) return;
    }
}
static void vc_PolygonMode(GLenum face, GLenum mode) { (void)face; if (mode != 0x1B02 /* GL_FILL */) warn_once("glPolygonMode(GL_LINE/GL_POINT)"); }
static void vc_PointSize(GLfloat size) { if (size != 1.0f) warn_once("glPointSize"); }
static void vc_PrimitiveRestartIndex(GLuint index) { (void)index; }
static void vc_ClampColor(GLenum target, GLenum clamp) { (void)target; (void)clamp; }
static void vc_DebugMessageCallback(void *callback, const void *user) { (void)callback; (void)user; }
static void vc_GetQueryObjectuiv(GLuint id, GLenum pname, GLuint *params) { glGetQueryObjectuiv(id, pname, params); }
static void vc_GetQueryObjectiv(GLuint id, GLenum pname, GLint *params) { GLuint value = 0; glGetQueryObjectuiv(id, pname, &value); *params = (GLint)value; }
static void vc_GetQueryObjectui64v(GLuint id, GLenum pname, uint64_t *params) { GLuint value = 0; glGetQueryObjectuiv(id, pname, &value); *params = value; }
static void vc_GetQueryObjecti64v(GLuint id, GLenum pname, int64_t *params) { GLuint value = 0; glGetQueryObjectuiv(id, pname, &value); *params = value; }

/* Emscripten's table entries for these take the 64-bit timeout as two 32-bit
 * halves; callers through libepoxy pass one 64-bit value. WebGL cannot block
 * in clientWaitSync (its maximum timeout is 0): callers poll, and syncs signal
 * once this thread returns to the browser's event loop. */
static GLenum vc_ClientWaitSync(GLsync sync, GLbitfield flags, GLuint64 timeout) { (void)timeout; return glClientWaitSync(sync, flags, 0); }
static void vc_WaitSync(GLsync sync, GLbitfield flags, GLuint64 timeout) { glWaitSync(sync, flags, timeout); }

/* ---------------------------------------------------------------------- */
/* Pixel formats and texture parameters that WebGL 2 lacks                 */

#define BGRA_EXT 0x80E1
#define BGRA8_EXT 0x93A1
#define SWIZZLE_FIRST 0x8E42 /* GL_TEXTURE_SWIZZLE_R ... _A, then _RGBA */
#define SWIZZLE_LAST 0x8E46

/* Copies a BGRA client image, laid out as the unpack state describes, into a
 * tightly packed RGBA image. NULL if the source is a pixel buffer object. */
static void *bgra_to_rgba(GLsizei width, GLsizei height, const void *pixels)
{
    struct vstate *s = cur();
    if (!pixels || s->pixel_unpack_buffer || width <= 0 || height <= 0) return NULL;
    size_t row_pixels = s->unpack_row_length > 0 ? (size_t)s->unpack_row_length : (size_t)width;
    size_t align = s->unpack_alignment > 0 ? (size_t)s->unpack_alignment : 4;
    size_t stride = (row_pixels * 4 + align - 1) / align * align;
    const uint8_t *src = (const uint8_t *)pixels + (size_t)s->unpack_skip_rows * stride + (size_t)s->unpack_skip_pixels * 4;
    uint8_t *out = malloc((size_t)width * (size_t)height * 4), *dst = out;
    if (!out) return NULL;
    for (GLsizei y = 0; y < height; y++, src += stride) {
        for (GLsizei x = 0; x < width; x++, dst += 4) {
            dst[0] = src[x * 4 + 2]; dst[1] = src[x * 4 + 1]; dst[2] = src[x * 4]; dst[3] = src[x * 4 + 3];
        }
    }
    return out;
}

/* Uploads a packed image with default unpack state, then restores it. */
static void packed_unpack(bool begin)
{
    struct vstate *s = cur();
    GLint values[] = {4, 0, 0, 0};
    const GLenum names[] = {GL_UNPACK_ALIGNMENT, GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_PIXELS, GL_UNPACK_SKIP_ROWS};
    if (!begin) { values[0] = s->unpack_alignment; values[1] = s->unpack_row_length; values[2] = s->unpack_skip_pixels; values[3] = s->unpack_skip_rows; }
    for (int i = 0; i < 4; i++) glPixelStorei(names[i], values[i]);
}

static GLint rgba_internal_format(GLint internal)
{
    if (internal == BGRA_EXT) return GL_RGBA;
    if (internal == BGRA8_EXT) return GL_RGBA8;
    return internal;
}

static void vc_TexImage2D(GLenum target, GLint level, GLint internal, GLsizei width, GLsizei height,
                          GLint border, GLenum format, GLenum type, const void *pixels)
{
    if (format != BGRA_EXT || type != GL_UNSIGNED_BYTE) {
        glTexImage2D(target, level, rgba_internal_format(internal), width, height, border, format, type, pixels);
        return;
    }
    void *rgba = bgra_to_rgba(width, height, pixels);
    if (rgba) packed_unpack(true);
    glTexImage2D(target, level, rgba_internal_format(internal), width, height, border, GL_RGBA, type, rgba ? rgba : pixels);
    if (rgba) { packed_unpack(false); free(rgba); }
}

static void vc_TexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei width, GLsizei height,
                             GLenum format, GLenum type, const void *pixels)
{
    if (format != BGRA_EXT || type != GL_UNSIGNED_BYTE) {
        glTexSubImage2D(target, level, x, y, width, height, format, type, pixels);
        return;
    }
    void *rgba = bgra_to_rgba(width, height, pixels);
    if (rgba) packed_unpack(true);
    glTexSubImage2D(target, level, x, y, width, height, GL_RGBA, type, rgba ? rgba : pixels);
    if (rgba) { packed_unpack(false); free(rgba); }
}

/* BGRA images are converted when uploaded, so swizzles that only undo the
 * red/blue order are unnecessary; others cannot be expressed in WebGL 2. */
static void vc_TexParameteri(GLenum target, GLenum pname, GLint param)
{
    if (pname >= SWIZZLE_FIRST && pname <= SWIZZLE_LAST) {
        if (param != (GLint)(GL_RED + (pname - SWIZZLE_FIRST)) && !(pname == SWIZZLE_FIRST && param == GL_BLUE) &&
            !(pname == SWIZZLE_FIRST + 2 && param == GL_RED))
            warn_once("texture swizzle");
        return;
    }
    glTexParameteri(target, pname, param);
}
static void vc_TexParameteriv(GLenum target, GLenum pname, const GLint *params)
{
    if (pname >= SWIZZLE_FIRST && pname <= SWIZZLE_LAST) {
        if (pname == SWIZZLE_LAST) warn_once("texture swizzle");
        else vc_TexParameteri(target, pname, params[0]);
        return;
    }
    glTexParameteriv(target, pname, params);
}

/* GL errors belong to the virtual context whose call raised them. */
static GLenum pending_error[MAX_CONTEXTS];

static void collect_errors(int id)
{
    for (int i = 0; i < 16; i++) {
        GLenum error = glGetError();
        if (error == GL_NO_ERROR) break;
        if (id >= 0 && !pending_error[id]) pending_error[id] = error;
    }
}
static GLenum vc_GetError(void)
{
    GLenum error = pending_error[current_id];
    if (error) { pending_error[current_id] = GL_NO_ERROR; return error; }
    return glGetError();
}

/* Immutable texture storage needs a sized format; WebGL 2 has no
 * luminance, alpha or BGRA ones. */
static GLenum sized_format(GLenum internal)
{
    switch (internal) {
    case GL_RGBA: case BGRA_EXT: case BGRA8_EXT: return GL_RGBA8;
    case GL_RGB: return GL_RGB8;
    case GL_LUMINANCE_ALPHA: case 0x8045 /* GL_LUMINANCE8_ALPHA8 */: return GL_RG8;
    case GL_LUMINANCE: case GL_ALPHA: case 0x8040 /* GL_LUMINANCE8 */: case 0x803C /* GL_ALPHA8 */: return GL_R8;
    default: return internal;
    }
}
/* Names texture formats WebGL rejects, once each; the error stays with the
 * calling context. */
static void report_format(const char *call, GLenum internal)
{
    GLenum error = glGetError();
    if (error == GL_NO_ERROR) return;
    if (!pending_error[current_id]) pending_error[current_id] = error;
    char what[64];
    snprintf(what, sizeof(what), "%s with format 0x%x", call, internal);
    warn_once(what);
}
static void vc_TexStorage2D(GLenum target, GLsizei levels, GLenum internal, GLsizei width, GLsizei height)
{
    collect_errors(current_id);
    glTexStorage2D(target, levels, sized_format(internal), width, height);
    report_format("glTexStorage2D", internal);
}
static void vc_TexStorage3D(GLenum target, GLsizei levels, GLenum internal, GLsizei width, GLsizei height, GLsizei depth)
{
    collect_errors(current_id);
    glTexStorage3D(target, levels, sized_format(internal), width, height, depth);
    report_format("glTexStorage3D", internal);
}

/* ---------------------------------------------------------------------- */
/* Virtual contexts                                                        */

#define APPLY(field, call) do { if (memcmp(&a->field, &b->field, sizeof(a->field))) { call; } } while (0)

static void apply(struct vstate *a, struct vstate *b)
{
    for (size_t i = 0; i < sizeof(capabilities) / sizeof(capabilities[0]); i++) {
        bool va = *capability(a, capabilities[i]), vb = *capability(b, capabilities[i]);
        if (va != vb) { if (vb) glEnable(capabilities[i]); else glDisable(capabilities[i]); }
    }
    APPLY(blend_color, glBlendColor(b->blend_color[0], b->blend_color[1], b->blend_color[2], b->blend_color[3]));
    if (a->blend_eq_rgb != b->blend_eq_rgb || a->blend_eq_alpha != b->blend_eq_alpha)
        glBlendEquationSeparate(b->blend_eq_rgb, b->blend_eq_alpha);
    if (a->blend_src_rgb != b->blend_src_rgb || a->blend_dst_rgb != b->blend_dst_rgb ||
        a->blend_src_alpha != b->blend_src_alpha || a->blend_dst_alpha != b->blend_dst_alpha)
        glBlendFuncSeparate(b->blend_src_rgb, b->blend_dst_rgb, b->blend_src_alpha, b->blend_dst_alpha);
    APPLY(color_mask, glColorMask(b->color_mask[0], b->color_mask[1], b->color_mask[2], b->color_mask[3]));
    APPLY(depth_mask, glDepthMask(b->depth_mask));
    APPLY(clear_color, glClearColor(b->clear_color[0], b->clear_color[1], b->clear_color[2], b->clear_color[3]));
    APPLY(clear_depth, glClearDepthf(b->clear_depth));
    APPLY(clear_stencil, glClearStencil(b->clear_stencil));
    APPLY(depth_func, glDepthFunc(b->depth_func));
    if (a->depth_near != b->depth_near || a->depth_far != b->depth_far) glDepthRangef(b->depth_near, b->depth_far);
    APPLY(cull_mode, glCullFace(b->cull_mode));
    APPLY(front_face, glFrontFace(b->front_face));
    APPLY(line_width, glLineWidth(b->line_width));
    if (a->polygon_factor != b->polygon_factor || a->polygon_units != b->polygon_units) glPolygonOffset(b->polygon_factor, b->polygon_units);
    if (a->coverage_value != b->coverage_value || a->coverage_invert != b->coverage_invert) glSampleCoverage(b->coverage_value, b->coverage_invert);
    for (int f = 0; f < 2; f++) {
        GLenum face = f ? GL_BACK : GL_FRONT;
        if (a->stencil_func[f] != b->stencil_func[f] || a->stencil_ref[f] != b->stencil_ref[f] || a->stencil_value_mask[f] != b->stencil_value_mask[f])
            glStencilFuncSeparate(face, b->stencil_func[f], b->stencil_ref[f], b->stencil_value_mask[f]);
        if (a->stencil_fail[f] != b->stencil_fail[f] || a->stencil_zfail[f] != b->stencil_zfail[f] || a->stencil_zpass[f] != b->stencil_zpass[f])
            glStencilOpSeparate(face, b->stencil_fail[f], b->stencil_zfail[f], b->stencil_zpass[f]);
        if (a->stencil_write_mask[f] != b->stencil_write_mask[f]) glStencilMaskSeparate(face, b->stencil_write_mask[f]);
    }
    APPLY(scissor, glScissor(b->scissor[0], b->scissor[1], b->scissor[2], b->scissor[3]));
    APPLY(viewport, glViewport(b->viewport[0], b->viewport[1], b->viewport[2], b->viewport[3]));
    for (size_t i = 0; i < sizeof(pixel_stores) / sizeof(pixel_stores[0]); i++) {
        GLint va = *pixel_store(a, pixel_stores[i]), vb = *pixel_store(b, pixel_stores[i]);
        if (va != vb) glPixelStorei(pixel_stores[i], vb);
    }
    APPLY(hint_mipmap, glHint(GL_GENERATE_MIPMAP_HINT, b->hint_mipmap));
    APPLY(hint_derivative, glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT, b->hint_derivative));

    /* Indexed bindings also replace the generic binding, so apply them first. */
    for (int i = 0; i < MAX_UBO; i++) {
        APPLY(ubo[i], b->ubo[i].size ? glBindBufferRange(GL_UNIFORM_BUFFER, i, b->ubo[i].buffer, b->ubo[i].offset, b->ubo[i].size)
                                     : glBindBufferBase(GL_UNIFORM_BUFFER, i, b->ubo[i].buffer));
    }
    APPLY(transform_feedback, glBindTransformFeedback(GL_TRANSFORM_FEEDBACK, b->transform_feedback));
    for (int i = 0; i < MAX_TFB; i++) {
        APPLY(tfb[i], b->tfb[i].size ? glBindBufferRange(GL_TRANSFORM_FEEDBACK_BUFFER, i, b->tfb[i].buffer, b->tfb[i].offset, b->tfb[i].size)
                                     : glBindBufferBase(GL_TRANSFORM_FEEDBACK_BUFFER, i, b->tfb[i].buffer));
    }
    /* Always rebind generic buffers: indexed binds above may have changed them. */
    glBindBuffer(GL_UNIFORM_BUFFER, b->uniform_buffer);
    glBindBuffer(GL_TRANSFORM_FEEDBACK_BUFFER, b->transform_feedback_buffer);
    APPLY(array_buffer, glBindBuffer(GL_ARRAY_BUFFER, b->array_buffer));
    APPLY(copy_read_buffer, glBindBuffer(GL_COPY_READ_BUFFER, b->copy_read_buffer));
    APPLY(copy_write_buffer, glBindBuffer(GL_COPY_WRITE_BUFFER, b->copy_write_buffer));
    APPLY(pixel_pack_buffer, glBindBuffer(GL_PIXEL_PACK_BUFFER, b->pixel_pack_buffer));
    APPLY(pixel_unpack_buffer, glBindBuffer(GL_PIXEL_UNPACK_BUFFER, b->pixel_unpack_buffer));
    APPLY(vertex_array, glBindVertexArray(b->vertex_array));
    APPLY(draw_framebuffer, glBindFramebuffer(GL_DRAW_FRAMEBUFFER, b->draw_framebuffer));
    APPLY(read_framebuffer, glBindFramebuffer(GL_READ_FRAMEBUFFER, b->read_framebuffer));
    APPLY(renderbuffer, glBindRenderbuffer(GL_RENDERBUFFER, b->renderbuffer));
    APPLY(program, glUseProgram(b->program));

    int units = a->max_unit > b->max_unit ? a->max_unit : b->max_unit;
    for (int u = 0; u <= units; u++) {
        bool active = false;
        for (int t = 0; t < T_COUNT; t++) {
            if (a->textures[u][t] != b->textures[u][t]) {
                if (!active) { glActiveTexture(GL_TEXTURE0 + u); active = true; }
                glBindTexture(texture_targets[t], b->textures[u][t]);
            }
        }
        if (a->samplers[u] != b->samplers[u]) glBindSampler(u, b->samplers[u]);
    }
    glActiveTexture(b->active_texture);
    if (b->max_unit < a->max_unit) b->max_unit = a->max_unit;

    for (int i = 0; i < MAX_ATTRIBS; i++) {
        if (a->attrib_type[i] == b->attrib_type[i] && !memcmp(&a->attrib[i], &b->attrib[i], sizeof(a->attrib[i]))) continue;
        if (b->attrib_type[i] == GL_INT) glVertexAttribI4iv(i, b->attrib[i].i);
        else if (b->attrib_type[i] == GL_UNSIGNED_INT) glVertexAttribI4uiv(i, b->attrib[i].u);
        else glVertexAttrib4fv(i, b->attrib[i].f);
    }
}

int epoxy_webgl_context_create(void)
{
    for (int id = 1; id < MAX_CONTEXTS; id++) {
        if (!contexts[id]) {
            contexts[id] = malloc(sizeof(struct vstate));
            init_state(contexts[id]);
            /* New contexts start with the window's viewport, as in EGL. */
            memcpy(contexts[id]->viewport, cur()->viewport, sizeof(contexts[id]->viewport));
            memcpy(contexts[id]->scissor, cur()->viewport, sizeof(contexts[id]->scissor));
            return id;
        }
    }
    fprintf(stderr, "webgl-compat: too many GL contexts\n");
    return -1;
}

void epoxy_webgl_make_current(int id)
{
    if (id < 0 || id >= MAX_CONTEXTS || !contexts[id] || id == current_id) return;
    struct vstate *from = cur();
    collect_errors(current_id);
    apply(from, contexts[id]);
    collect_errors(-1); /* restoring state must not report errors */
    current_id = id;
}

void epoxy_webgl_context_destroy(int id)
{
    if (id <= 0 || id >= MAX_CONTEXTS || !contexts[id]) return;
    if (id == current_id) epoxy_webgl_make_current(0);
    free(contexts[id]);
    contexts[id] = NULL;
    pending_error[id] = GL_NO_ERROR;
}

int epoxy_webgl_current_context(void) { return current_id; }

/* ---------------------------------------------------------------------- */
/* Symbol lookup for libepoxy                                              */

struct entry { const char *name; void *function; };
#define E(name, fn) { name, (void *)(fn) }
static const struct entry compat[] = {
    E("glEnable", vc_Enable), E("glDisable", vc_Disable),
    E("glBlendColor", vc_BlendColor), E("glBlendEquation", vc_BlendEquation), E("glBlendEquationSeparate", vc_BlendEquationSeparate),
    E("glBlendFunc", vc_BlendFunc), E("glBlendFuncSeparate", vc_BlendFuncSeparate),
    E("glColorMask", vc_ColorMask), E("glDepthMask", vc_DepthMask), E("glStencilMask", vc_StencilMask), E("glStencilMaskSeparate", vc_StencilMaskSeparate),
    E("glClearColor", vc_ClearColor), E("glClearDepthf", vc_ClearDepthf), E("glClearDepth", vc_ClearDepth), E("glClearStencil", vc_ClearStencil),
    E("glDepthFunc", vc_DepthFunc), E("glDepthRangef", vc_DepthRangef), E("glDepthRange", vc_DepthRange),
    E("glCullFace", vc_CullFace), E("glFrontFace", vc_FrontFace), E("glLineWidth", vc_LineWidth),
    E("glPolygonOffset", vc_PolygonOffset), E("glSampleCoverage", vc_SampleCoverage),
    E("glStencilFunc", vc_StencilFunc), E("glStencilFuncSeparate", vc_StencilFuncSeparate),
    E("glStencilOp", vc_StencilOp), E("glStencilOpSeparate", vc_StencilOpSeparate),
    E("glScissor", vc_Scissor), E("glViewport", vc_Viewport), E("glPixelStorei", vc_PixelStorei), E("glHint", vc_Hint),
    E("glBindBuffer", vc_BindBuffer), E("glBindBufferBase", vc_BindBufferBase), E("glBindBufferRange", vc_BindBufferRange),
    E("glBindVertexArray", vc_BindVertexArray), E("glBindFramebuffer", vc_BindFramebuffer), E("glBindRenderbuffer", vc_BindRenderbuffer),
    E("glActiveTexture", vc_ActiveTexture), E("glBindTexture", vc_BindTexture), E("glBindSampler", vc_BindSampler),
    E("glUseProgram", vc_UseProgram), E("glBindTransformFeedback", vc_BindTransformFeedback),
    E("glVertexAttrib1f", vc_VertexAttrib1f), E("glVertexAttrib2f", vc_VertexAttrib2f), E("glVertexAttrib3f", vc_VertexAttrib3f), E("glVertexAttrib4f", vc_VertexAttrib4f),
    E("glVertexAttrib1fv", vc_VertexAttrib1fv), E("glVertexAttrib2fv", vc_VertexAttrib2fv), E("glVertexAttrib3fv", vc_VertexAttrib3fv), E("glVertexAttrib4fv", vc_VertexAttrib4fv),
    E("glVertexAttribI4i", vc_VertexAttribI4i), E("glVertexAttribI4ui", vc_VertexAttribI4ui), E("glVertexAttribI4iv", vc_VertexAttribI4iv), E("glVertexAttribI4uiv", vc_VertexAttribI4uiv),
    E("glDeleteBuffers", vc_DeleteBuffers), E("glDeleteTextures", vc_DeleteTextures), E("glDeleteSamplers", vc_DeleteSamplers),
    E("glDeleteFramebuffers", vc_DeleteFramebuffers), E("glDeleteRenderbuffers", vc_DeleteRenderbuffers),
    E("glDeleteVertexArrays", vc_DeleteVertexArrays), E("glDeleteTransformFeedbacks", vc_DeleteTransformFeedbacks), E("glDeleteProgram", vc_DeleteProgram),
    E("glMapBufferRange", vc_MapBufferRange), E("glFlushMappedBufferRange", vc_FlushMappedBufferRange), E("glUnmapBuffer", vc_UnmapBuffer),
    E("glPolygonMode", vc_PolygonMode), E("glPointSize", vc_PointSize), E("glPrimitiveRestartIndex", vc_PrimitiveRestartIndex),
    E("glClampColor", vc_ClampColor), E("glDebugMessageCallback", vc_DebugMessageCallback), E("glDebugMessageCallbackKHR", vc_DebugMessageCallback),
    E("glGetQueryObjectuiv", vc_GetQueryObjectuiv), E("glGetQueryObjectiv", vc_GetQueryObjectiv),
    E("glGetQueryObjectui64v", vc_GetQueryObjectui64v), E("glGetQueryObjecti64v", vc_GetQueryObjecti64v),
    E("glGetBufferSubData", vc_GetBufferSubData),
    E("glClientWaitSync", vc_ClientWaitSync), E("glWaitSync", vc_WaitSync), E("glGetError", vc_GetError),
    E("glTexImage2D", vc_TexImage2D), E("glTexSubImage2D", vc_TexSubImage2D),
    E("glTexStorage2D", vc_TexStorage2D), E("glTexStorage3D", vc_TexStorage3D),
    E("glGenBuffers", vc_GenBuffers), E("glBufferData", vc_BufferData), E("glBufferSubData", vc_BufferSubData),
    E("glCopyBufferSubData", vc_CopyBufferSubData), E("glDrawElements", vc_DrawElements),
    E("glDrawElementsInstanced", vc_DrawElementsInstanced), E("glDrawRangeElements", vc_DrawRangeElements),
    E("glEndTransformFeedback", vc_EndTransformFeedback), E("glReadPixels", vc_ReadPixels),
    E("glTexParameteri", vc_TexParameteri), E("glTexParameteriv", vc_TexParameteriv),
    /* EGL, linked statically by Emscripten */
    E("eglBindAPI", eglBindAPI), E("eglChooseConfig", eglChooseConfig), E("eglCreateContext", eglCreateContext),
    E("eglCreateWindowSurface", eglCreateWindowSurface), E("eglDestroyContext", eglDestroyContext), E("eglDestroySurface", eglDestroySurface),
    E("eglGetConfigAttrib", eglGetConfigAttrib), E("eglGetConfigs", eglGetConfigs), E("eglGetCurrentContext", eglGetCurrentContext),
    E("eglGetCurrentDisplay", eglGetCurrentDisplay), E("eglGetCurrentSurface", eglGetCurrentSurface), E("eglGetDisplay", eglGetDisplay),
    E("eglGetError", eglGetError), E("eglGetProcAddress", eglGetProcAddress), E("eglInitialize", eglInitialize),
    E("eglMakeCurrent", eglMakeCurrent), E("eglQueryAPI", eglQueryAPI), E("eglQueryContext", eglQueryContext),
    E("eglQueryString", eglQueryString), E("eglQuerySurface", eglQuerySurface), E("eglReleaseThread", eglReleaseThread),
    E("eglSwapBuffers", eglSwapBuffers), E("eglSwapInterval", eglSwapInterval), E("eglTerminate", eglTerminate),
    E("eglWaitClient", eglWaitClient), E("eglWaitGL", eglWaitGL), E("eglWaitNative", eglWaitNative),
};

void *epoxy_webgl_lookup(const char *name)
{
    for (size_t i = 0; i < sizeof(compat) / sizeof(compat[0]); i++) {
        if (!strcmp(compat[i].name, name)) return compat[i].function;
    }
    return emscripten_webgl_get_proc_address(name);
}
