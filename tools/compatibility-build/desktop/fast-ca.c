// SPDX-License-Identifier: MIT
/*
 * Preloaded into the Minecraft Launcher (see /usr/local/bin/minecraft-launcher).
 *
 * libcurl loads the whole system certificate bundle into every new TLS
 * context, and also sets the hashed certificate directory. Under full
 * emulation parsing the 146-certificate bundle takes several seconds, and
 * Mojang's servers drop a TLS handshake that is not finished within about
 * 5 seconds. Skipping the bundle file leaves verification unchanged: OpenSSL
 * finds each needed authority in /etc/ssl/certs by its subject hash.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>

typedef struct x509_store_st X509_STORE;
typedef struct ssl_ctx_st SSL_CTX;

static const char bundle[] = "/etc/ssl/certs/ca-certificates.crt";
static const char directory[] = "/etc/ssl/certs";

static int is_bundle(const char *file)
{
    return file && strcmp(file, bundle) == 0;
}

int X509_STORE_load_file(X509_STORE *store, const char *file)
{
    static int (*real)(X509_STORE *, const char *);
    static int (*load_path)(X509_STORE *, const char *);
    if (is_bundle(file)) {
        if (!load_path) load_path = (int (*)(X509_STORE *, const char *))dlsym(RTLD_NEXT, "X509_STORE_load_path");
        return load_path ? load_path(store, directory) : 0;
    }
    if (!real) real = (int (*)(X509_STORE *, const char *))dlsym(RTLD_NEXT, "X509_STORE_load_file");
    return real ? real(store, file) : 0;
}

int SSL_CTX_load_verify_locations(SSL_CTX *ctx, const char *file, const char *path)
{
    static int (*real)(SSL_CTX *, const char *, const char *);
    if (!real) real = (int (*)(SSL_CTX *, const char *, const char *))dlsym(RTLD_NEXT, "SSL_CTX_load_verify_locations");
    if (!real) return 0;
    if (is_bundle(file)) return real(ctx, NULL, path ? path : directory);
    return real(ctx, file, path);
}
