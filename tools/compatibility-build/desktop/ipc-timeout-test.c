// SPDX-License-Identifier: MIT
/*
 * Build-time check for ipc-timeout.c, run with it preloaded:
 *   ipc-timeout-test plain           the arguments are left alone
 *   ipc-timeout-test --type=utility  the switch is added as the last argument
 *   ipc-timeout-test --type=zygote   also, a fork request the zygote receives
 *                                    gets the switch as one more argument
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

static const char expected[] = "--ipc-connection-timeout=600";

static size_t put_int(char *buffer, size_t at, uint32_t value)
{
    memcpy(buffer + at, &value, 4);
    return at + 4;
}

static size_t put_string(char *buffer, size_t at, const char *text)
{
    size_t length = strlen(text), padded = (length + 3) & ~(size_t)3;
    at = put_int(buffer, at, length);
    memset(buffer + at, 0, padded);
    memcpy(buffer + at, text, length);
    return at + padded;
}

/* A fork request laid out like Chromium's ZygoteCommunication sends it. */
static size_t fork_request(char *buffer, uint32_t command, int with_switch)
{
    size_t at = 4;
    at = put_int(buffer, at, command);
    at = put_string(buffer, at, "renderer");
    at = put_int(buffer, at, with_switch ? 3 : 2);
    at = put_string(buffer, at, "/proc/self/exe");
    at = put_string(buffer, at, "--type=renderer");
    if (with_switch) at = put_string(buffer, at, expected);
    at = put_int(buffer, at, 1);  /* descriptor count */
    at = put_int(buffer, at, 7);  /* descriptor key */
    put_int(buffer, 0, at - 4);
    return at;
}

static ssize_t pass(int sockets[2], const char *request, size_t size, char *received, size_t capacity)
{
    struct iovec part = {received, capacity};
    struct msghdr message = {.msg_iov = &part, .msg_iovlen = 1};
    if (send(sockets[0], request, size, 0) != (ssize_t)size) return -1;
    return recvmsg(sockets[1], &message, 0);
}

static int check_zygote(void)
{
    int sockets[2];
    char request[256], want[256], received[512];
    if (socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sockets) != 0) return 1;
    size_t size = fork_request(request, 0, 0), want_size = fork_request(want, 0, 1);
    ssize_t n = pass(sockets, request, size, received, sizeof received);
    printf("fork request: %zd bytes received, %zu expected\n", n, want_size);
    if (n != (ssize_t)want_size || memcmp(received, want, want_size) != 0) return 1;
    /* Other commands (here: reap) are left alone. */
    size = fork_request(request, 1, 0);
    n = pass(sockets, request, size, received, sizeof received);
    if (n != (ssize_t)size || memcmp(received, request, size) != 0) return 1;
    /* A request that already has the switch is left alone. */
    n = pass(sockets, want, want_size, received, sizeof received);
    return n == (ssize_t)want_size && memcmp(received, want, want_size) == 0 ? 0 : 1;
}

int main(int argc, char **argv)
{
    if (argc < 2 || !getenv("PATH")) return 1;
    int added = argc == 3 && strcmp(argv[2], expected) == 0;
    if (strcmp(argv[1], "plain") == 0) return argc == 2 ? 0 : 1;
    printf("%s: switch %s\n", argv[1], added ? "added" : "missing");
    if (!added) return 1;
    return strcmp(argv[1], "--type=zygote") == 0 ? check_zygote() : 0;
}
