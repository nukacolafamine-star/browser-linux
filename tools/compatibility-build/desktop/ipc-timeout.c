// SPDX-License-Identifier: MIT
/*
 * Preloaded into the Minecraft Launcher (see /usr/local/bin/minecraft-launcher).
 *
 * The launcher's interface runs in an embedded Chromium, whose helper
 * processes (network service, storage service, GPU process, renderers) exit
 * when their IPC channel to the main process is not connected within 15
 * seconds. Under full emulation the main process is busy for longer than that
 * while it starts, so the network service exits, the page loading through it
 * fails, and the launcher window stays blank. Chromium's
 * --ipc-connection-timeout switch lengthens the wait, but the launcher does
 * not pass its own command line on to Chromium, so this library adds the
 * switch to each helper process:
 *  - helpers started with exec (the network service, the zygotes): to the
 *    arguments main() receives;
 *  - helpers forked by a zygote (renderers, storage service, GPU process):
 *    to the argument list in the fork request the zygote receives.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define SWITCH_NAME "--ipc-connection-timeout"
static const char timeout_switch[] = SWITCH_NAME "=600";

/* Set in a Chromium zygote process. */
static pid_t zygote;

static int starts_with(const char *text, const char *prefix)
{
    return strncmp(text, prefix, strlen(prefix)) == 0;
}

typedef int (*main_function)(int, char **, char **);
typedef int (*start_function)(main_function, int, char **, void (*)(void), void (*)(void),
                              void (*)(void), void *);

int __libc_start_main(main_function main_fn, int argc, char **argv, void (*init)(void),
                      void (*fini)(void), void (*rtld_fini)(void), void *stack_end)
{
    start_function real = (start_function)dlsym(RTLD_NEXT, "__libc_start_main");
    int helper = 0, has_switch = 0;
    for (int i = 1; i < argc; i++) {
        if (starts_with(argv[i], "--type=")) helper = 1;
        if (strcmp(argv[i], "--type=zygote") == 0) zygote = getpid();
        if (starts_with(argv[i], SWITCH_NAME)) has_switch = 1;
    }
    if (helper && !has_switch) {
        /* glibc expects the environment to follow the arguments' NULL. */
        char **environment = argv + argc + 1;
        size_t count = 0;
        while (environment[count]) count++;
        char **arguments = malloc((argc + 2 + count + 1) * sizeof *arguments);
        if (arguments) {
            memcpy(arguments, argv, argc * sizeof *arguments);
            arguments[argc] = (char *)timeout_switch;
            arguments[argc + 1] = NULL;
            memcpy(arguments + argc + 2, environment, (count + 1) * sizeof *arguments);
            argv = arguments;
            argc++;
        }
    }
    return real(main_fn, argc, argv, init, fini, rtld_fini, stack_end);
}

/*
 * A fork request is a base::Pickle: a uint32 payload size, then the payload:
 * int32 command (0 = fork), the process type as a string, an int32 argument
 * count and the arguments, then file descriptor information. A string is an
 * int32 length followed by the bytes, zero-padded to a multiple of 4.
 */
static size_t padded(size_t length)
{
    return (length + 3) & ~(size_t)3;
}

static int read_int(const char *buffer, size_t size, size_t *at, uint32_t *value)
{
    if (*at + 4 > size) return 0;
    memcpy(value, buffer + *at, 4);
    *at += 4;
    return 1;
}

/* Returns the new size; a message that is not a fork request is unchanged. */
static size_t add_switch(char *buffer, size_t size, size_t capacity)
{
    size_t at = 0, count_at;
    uint32_t value, count;
    if (!read_int(buffer, size, &at, &value) || value != size - 4) return size;
    if (!read_int(buffer, size, &at, &value) || value != 0) return size;
    if (!read_int(buffer, size, &at, &value) || value > 64 || at + padded(value) > size) return size;
    at += padded(value);
    count_at = at;
    if (!read_int(buffer, size, &at, &count) || count == 0 || count > 4096) return size;
    for (uint32_t i = 0; i < count; i++) {
        if (!read_int(buffer, size, &at, &value) || value > size || at + padded(value) > size) return size;
        if (value >= strlen(SWITCH_NAME) && memcmp(buffer + at, SWITCH_NAME, strlen(SWITCH_NAME)) == 0)
            return size;
        at += padded(value);
    }
    uint32_t length = strlen(timeout_switch);
    size_t added = 4 + padded(length);
    if (size + added > capacity) return size;
    memmove(buffer + at + added, buffer + at, size - at);
    memcpy(buffer + at, &length, 4);
    memset(buffer + at + 4, 0, padded(length));
    memcpy(buffer + at + 4, timeout_switch, length);
    count++;
    memcpy(buffer + count_at, &count, 4);
    value = size + added - 4;
    memcpy(buffer, &value, 4);
    return size + added;
}

ssize_t recvmsg(int fd, struct msghdr *message, int flags)
{
    static ssize_t (*real)(int, struct msghdr *, int);
    if (!real) real = (ssize_t (*)(int, struct msghdr *, int))dlsym(RTLD_NEXT, "recvmsg");
    ssize_t received = real(fd, message, flags);
    /* Only the zygote itself reads fork requests, not the helpers it forks. */
    if (received > 0 && zygote && getpid() == zygote && message->msg_iovlen == 1 &&
        !(message->msg_flags & MSG_TRUNC))
        received = add_switch(message->msg_iov[0].iov_base, received, message->msg_iov[0].iov_len);
    return received;
}
