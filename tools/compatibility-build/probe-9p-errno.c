/* Compile with the pinned Emscripten toolchain, then execute using Node. */
#include <errno.h>
#include <stdio.h>
#include "9p-errno-emscripten.h"
struct errno_case { int host; int linux_errno; };
static const struct errno_case cases[] = {
    {0, 0},
    {63, 1}, /* EPERM */
    {44, 2}, /* ENOENT */
    {71, 3}, /* ESRCH */
    {27, 4}, /* EINTR */
    {29, 5}, /* EIO */
    {60, 6}, /* ENXIO */
    {1, 7}, /* E2BIG */
    {45, 8}, /* ENOEXEC */
    {8, 9}, /* EBADF */
    {12, 10}, /* ECHILD */
    {6, 11}, /* EAGAIN */
    {48, 12}, /* ENOMEM */
    {2, 13}, /* EACCES */
    {21, 14}, /* EFAULT */
    {10, 16}, /* EBUSY */
    {20, 17}, /* EEXIST */
    {75, 18}, /* EXDEV */
    {43, 19}, /* ENODEV */
    {54, 20}, /* ENOTDIR */
    {31, 21}, /* EISDIR */
    {28, 22}, /* EINVAL */
    {41, 23}, /* ENFILE */
    {33, 24}, /* EMFILE */
    {59, 25}, /* ENOTTY */
    {74, 26}, /* ETXTBSY */
    {22, 27}, /* EFBIG */
    {51, 28}, /* ENOSPC */
    {70, 29}, /* ESPIPE */
    {69, 30}, /* EROFS */
    {34, 31}, /* EMLINK */
    {64, 32}, /* EPIPE */
    {18, 33}, /* EDOM */
    {68, 34}, /* ERANGE */
    {16, 35}, /* EDEADLK */
    {37, 36}, /* ENAMETOOLONG */
    {46, 37}, /* ENOLCK */
    {52, 38}, /* ENOSYS */
    {55, 39}, /* ENOTEMPTY */
    {32, 40}, /* ELOOP */
    {49, 42}, /* ENOMSG */
    {24, 43}, /* EIDRM */
    {47, 67}, /* ENOLINK */
    {65, 71}, /* EPROTO */
    {36, 72}, /* EMULTIHOP */
    {9, 74}, /* EBADMSG */
    {61, 75}, /* EOVERFLOW */
    {25, 84}, /* EILSEQ */
    {57, 88}, /* ENOTSOCK */
    {17, 89}, /* EDESTADDRREQ */
    {35, 90}, /* EMSGSIZE */
    {67, 91}, /* EPROTOTYPE */
    {50, 92}, /* ENOPROTOOPT */
    {66, 93}, /* EPROTONOSUPPORT */
    {5, 97}, /* EAFNOSUPPORT */
    {3, 98}, /* EADDRINUSE */
    {4, 99}, /* EADDRNOTAVAIL */
    {38, 100}, /* ENETDOWN */
    {40, 101}, /* ENETUNREACH */
    {39, 102}, /* ENETRESET */
    {13, 103}, /* ECONNABORTED */
    {15, 104}, /* ECONNRESET */
    {42, 105}, /* ENOBUFS */
    {30, 106}, /* EISCONN */
    {53, 107}, /* ENOTCONN */
    {73, 110}, /* ETIMEDOUT */
    {14, 111}, /* ECONNREFUSED */
    {23, 113}, /* EHOSTUNREACH */
    {7, 114}, /* EALREADY */
    {26, 115}, /* EINPROGRESS */
    {72, 116}, /* ESTALE */
    {19, 122}, /* EDQUOT */
    {11, 125}, /* ECANCELED */
    {62, 130}, /* EOWNERDEAD */
    {56, 131}, /* ENOTRECOVERABLE */
    {100, 60}, /* ENOSTR */
    {101, 59}, /* EBFONT */
    {102, 57}, /* EBADSLT */
    {103, 56}, /* EBADRQC */
    {104, 55}, /* ENOANO */
    {105, 15}, /* ENOTBLK */
    {106, 44}, /* ECHRNG */
    {107, 46}, /* EL3HLT */
    {108, 47}, /* EL3RST */
    {109, 48}, /* ELNRNG */
    {110, 49}, /* EUNATCH */
    {111, 50}, /* ENOCSI */
    {112, 51}, /* EL2HLT */
    {113, 52}, /* EBADE */
    {114, 53}, /* EBADR */
    {115, 54}, /* EXFULL */
    {116, 61}, /* ENODATA */
    {117, 62}, /* ETIME */
    {118, 63}, /* ENOSR */
    {119, 64}, /* ENONET */
    {120, 65}, /* ENOPKG */
    {121, 66}, /* EREMOTE */
    {122, 68}, /* EADV */
    {123, 69}, /* ESRMNT */
    {124, 70}, /* ECOMM */
    {125, 73}, /* EDOTDOT */
    {126, 76}, /* ENOTUNIQ */
    {127, 77}, /* EBADFD */
    {128, 78}, /* EREMCHG */
    {129, 79}, /* ELIBACC */
    {130, 80}, /* ELIBBAD */
    {131, 81}, /* ELIBSCN */
    {132, 82}, /* ELIBMAX */
    {133, 83}, /* ELIBEXEC */
    {134, 85}, /* ERESTART */
    {135, 86}, /* ESTRPIPE */
    {136, 87}, /* EUSERS */
    {137, 94}, /* ESOCKTNOSUPPORT */
    {138, 95}, /* EOPNOTSUPP */
    {139, 96}, /* EPFNOSUPPORT */
    {140, 108}, /* ESHUTDOWN */
    {141, 109}, /* ETOOMANYREFS */
    {142, 112}, /* EHOSTDOWN */
    {143, 117}, /* EUCLEAN */
    {144, 118}, /* ENOTNAM */
    {145, 119}, /* ENAVAIL */
    {146, 120}, /* EISNAM */
    {147, 121}, /* EREMOTEIO */
    {148, 123}, /* ENOMEDIUM */
    {149, 124}, /* EMEDIUMTYPE */
    {150, 126}, /* ENOKEY */
    {151, 127}, /* EKEYEXPIRED */
    {152, 128}, /* EKEYREVOKED */
    {153, 129}, /* EKEYREJECTED */
    {154, 132}, /* ERFKILL */
    {155, 133}, /* EHWPOISON */
    {156, 45}, /* EL2NSYNC */
    {58, 95}, {76, 1}, {77, 5}, {999, 5}, {-1, 5}
};
int main(void)
{
    _Static_assert(EPERM == 63, "Unexpected Emscripten errno ABI");
    _Static_assert(ENOENT == 44, "Unexpected Emscripten errno ABI");
    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        int got = browser_linux_errno_to_dotl(cases[i].host);
        if (got != cases[i].linux_errno) {
            fprintf(stderr, "errno %d: expected Linux %d, got %d\n", cases[i].host, cases[i].linux_errno, got);
            return 1;
        }
    }
    puts("BROWSER_LINUX_9P_ERRNO_PROBE_OK 137 cases");
    return 0;
}
