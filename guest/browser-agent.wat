;; SPDX-License-Identifier: GPL-2.0-only
;; Linux/Wasm user process. The runtime provides the browser transport;
;; its requests execute Linux syscalls in this process's kernel context.
(module
  (import "env" "memory" (memory 1 65536 shared))
  (import "env" "__memory_base" (global $base i32))
  (import "env" "__stack_pointer" (global $sp (mut i32)))
  (import "env" "browser_agent" (func $agent (param i32 i32)))
  (func (export "__wasm_apply_data_relocs"))
  (func (export "__set_tls_base") (param i32))
  (func (export "_start")
    global.get $base
    global.get $sp
    call $agent
    unreachable)
)
