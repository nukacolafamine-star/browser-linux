# WebAssembly synchronization reads

The shipped compatibility transformation is implemented in
`tools/kernel-fix.mjs`. This JavaScript file is the editable source of the
transformation; the build applies it to the pinned upstream binary after DWARF
removal. It checks the complete input hash, exported function indices, original
function hashes, instruction bytes and offsets, and complete output hash.

This is a modification of the existing kernel binary. It is **not** a claim
that the Linux C sources were rebuilt. The supplied upstream source bundle is
unchanged. The transformation and its tests are included with the project so
the changed binary can be reproduced and inspected.

## Why these reads need atomic instructions

Linux's generic ticket lock polls a shared counter with `READ_ONCE` semantics.
In this LLVM 18 build, those reads became ordinary WebAssembly `i32.load`
instructions. An ordinary Wasm load does not convey the C volatile constraint
to the browser's optimizing compiler. A warmed, contended ticket lock in
Windows WebKit 26.6 remained in its polling loop after the other thread had
released the lock. Changing only its reads to `i32.atomic.load` made the same
reproduction complete. The regression test retains both versions and checks
their observable behavior.

Kernel function-entry traces found the initial boot stall in
`scheduler_tick -> _raw_spin_lock`, with a CPU hotplug task also waiting in
`wait_task_inactive -> _raw_spin_lock_irqsave -> _raw_spin_lock`. After the
lock-read correction, another boot trace stopped in `wait_task_inactive`'s
own task-state polling. A later `/proc/uptime` read stopped in
`kcpustat_cpu_fetch`'s virtual CPU accounting snapshot loop. These observations motivated three narrowly scoped
changes:

| Function | Loads strengthened | Address read |
| --- | ---: | --- |
| `_raw_spin_lock` | 3 | Ticket-lock counter |
| `_raw_spin_lock_irqsave` | 3 | Ticket-lock counter |
| `_raw_spin_lock_irq` | 3 | Ticket-lock counter |
| `_raw_spin_lock_bh` | 3 | Ticket-lock counter |
| `wait_task_inactive` | 8 | `task_struct.__state`, `on_cpu`, `on_rq` |
| `kcpustat_cpu_fetch` | 7 | Current-task pointer; virtual CPU accounting sequence, state and CPU |

All twenty-seven accesses retain four-byte alignment, their original address and
their original loaded value. The new instructions add sequential consistency.
The task-state change includes the initial checks and later reads of these
same fields, including reads made while holding the task locks. It changes no
other task fields. The CPU accounting change preserves both the initial and
retry reads of its sequence counter and current-task pointer. The transformation adds twenty-seven bytes of executable code;
every other function body and every non-code section remains byte-for-byte
identical. The tests verify these boundaries and reject an unknown kernel or
a second application of the patch.

## C source equivalents for a future rebuild

The following describes the intended C semantics; it is **not an applied or
compiled C patch**, and does not promise that a C compiler will reproduce the
same instruction layout or the same limited set of inlined copies.

For `include/asm-generic/spinlock.h` in Linux 6.4.16, the WebAssembly-specific
form of `arch_spin_lock` must make its counter reads actual compiler atomic
loads. Its ticket-acquisition and polling operations can be expressed as:

```c
u32 val = __atomic_load_n(&lock->counter, __ATOMIC_SEQ_CST);
while (!__atomic_compare_exchange_n(&lock->counter, &val,
                                   val + (1U << 16), false,
                                   __ATOMIC_SEQ_CST, __ATOMIC_RELAXED))
        ;

u16 ticket = val >> 16;
if (ticket == (u16)val)
        return;

while (ticket != (u16)__atomic_load_n(&lock->counter, __ATOMIC_SEQ_CST))
        cpu_relax();
smp_mb();
```

For `kernel/sched/core.c:wait_task_inactive`, the loads of `p->__state`,
`p->on_cpu`, and `p->on_rq` used in the wait and its inlined `task_rq_lock`
helpers need the same property. At those sites, the required operation is
`__atomic_load_n(&p->FIELD, __ATOMIC_SEQ_CST)`, preserving the existing condition,
retry, locking, and return logic.

For `kernel/sched/cputime.c:kcpustat_cpu_fetch` and its inlined virtual CPU
accounting helper, the initial/retry reads of `rq->curr` and
`vtime->seqcount.sequence`, plus the reads of `vtime->state` and `vtime->cpu`,
must similarly remain observable atomic reads. This preserves the existing
sequence-counter consistency checks and retry logic; it does not replace
accounting data with a fabricated result or omit the `/proc/uptime` read.

A source rebuild should implement and test
architecture-wide `READ_ONCE` and conditional-load semantics instead of
assuming this hotfix has audited every synchronization loop in the kernel.

The WebAssembly community has previously discussed the loss of C volatile
semantics through ordinary Wasm loads and the use of atomic operations to
preserve them: [July 2018 WebAssembly CG notes](https://github.com/WebAssembly/meetings/blob/main/main/2018/CG-07-24.md).

These compatibility fixes do not establish that the experimental kernel is
free of other scheduler, filesystem, or memory-integrity bugs.
