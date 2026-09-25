// SPDX-License-Identifier: MIT
/*
 * Build-time check for fast-ca.c, run with it preloaded. Loads OpenSSL the
 * way the Minecraft Launcher loads libcurl (dlopen with RTLD_LOCAL), then
 * loads the system bundle through the preloaded function and checks that it
 * succeeds without parsing the bundle up front.
 */
#include <dlfcn.h>
#include <stdio.h>

int main(void)
{
    void *crypto = dlopen("libcrypto.so.3", RTLD_NOW | RTLD_LOCAL);
    if (!crypto) { fprintf(stderr, "libcrypto: %s\n", dlerror()); return 1; }
    void *(*store_new)(void) = (void *(*)(void))dlsym(crypto, "X509_STORE_new");
    int (*load_file)(void *, const char *) = (int (*)(void *, const char *))dlsym(RTLD_DEFAULT, "X509_STORE_load_file");
    void *(*objects)(void *) = (void *(*)(void *))dlsym(crypto, "X509_STORE_get0_objects");
    int (*count)(const void *) = (int (*)(const void *))dlsym(crypto, "OPENSSL_sk_num");
    if (!store_new || !load_file || !objects || !count) { fprintf(stderr, "missing symbols\n"); return 1; }
    if (dlsym(crypto, "X509_STORE_load_file") == (void *)load_file) {
        fprintf(stderr, "fast-ca.so is not preloaded\n");
        return 1;
    }
    void *store = store_new();
    int ok = load_file(store, "/etc/ssl/certs/ca-certificates.crt");
    int loaded = count(objects(store));
    printf("load_file=%d certificates parsed up front=%d\n", ok, loaded);
    /* Success, and no certificate parsed from the bundle. */
    return ok == 1 && loaded == 0 ? 0 : 1;
}
