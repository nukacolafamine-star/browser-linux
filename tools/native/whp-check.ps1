# In-memory check that a non-admin process can run x86 guest code directly on the
# CPU through the Windows Hypervisor Platform. Nothing is written to disk.
# Guest (16-bit real mode at the reset vector 0xFFFF0):
#   mov ecx, 2000000000 ; loop: dec ecx ; jnz loop ; out 10h, al (exits to us)
$ErrorActionPreference = 'Stop'
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'WhpLoopCheck'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$mod = $asm.DefineDynamicModule('WhpLoopCheck')
$tb = $mod.DefineType('WhpLoopCheck', 'Public, Class')
function Def($dll, $name, $ret, [Type[]]$params) {
  $m = $tb.DefinePInvokeMethod($name, $dll, [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $ret, $params, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $m.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
Def 'WinHvPlatform.dll' 'WHvCreatePartition' ([int]) @([IntPtr].MakeByRefType())
Def 'WinHvPlatform.dll' 'WHvSetPartitionProperty' ([int]) @([IntPtr], [int], [byte[]], [int])
Def 'WinHvPlatform.dll' 'WHvSetupPartition' ([int]) @([IntPtr])
Def 'WinHvPlatform.dll' 'WHvDeletePartition' ([int]) @([IntPtr])
Def 'WinHvPlatform.dll' 'WHvMapGpaRange' ([int]) @([IntPtr], [IntPtr], [UInt64], [UInt64], [int])
Def 'WinHvPlatform.dll' 'WHvCreateVirtualProcessor' ([int]) @([IntPtr], [int], [int])
Def 'WinHvPlatform.dll' 'WHvDeleteVirtualProcessor' ([int]) @([IntPtr], [int])
Def 'WinHvPlatform.dll' 'WHvRunVirtualProcessor' ([int]) @([IntPtr], [int], [byte[]], [int])
Def 'kernel32.dll' 'VirtualAlloc' ([IntPtr]) @([IntPtr], [IntPtr], [int], [int])
Def 'kernel32.dll' 'VirtualFree' ([bool]) @([IntPtr], [IntPtr], [int])
$t = $tb.CreateType()

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$iterations = 2000000000
$n = [BitConverter]::GetBytes([int]$iterations)
$code = [byte[]](0x66, 0xB9, $n[0], $n[1], $n[2], $n[3], 0x66, 0x49, 0x75, 0xFC, 0xE6, 0x10)
$mem = $t::VirtualAlloc([IntPtr]::Zero, [IntPtr]4096, 0x3000, 0x04)
[Runtime.InteropServices.Marshal]::Copy($code, 0, [IntPtr]($mem.ToInt64() + 0xFF0), $code.Length)
$p = [IntPtr]::Zero
$sw = [Diagnostics.Stopwatch]::StartNew()
"create=0x{0:X8}" -f $t::WHvCreatePartition([ref]$p)
try {
  "property=0x{0:X8}" -f $t::WHvSetPartitionProperty($p, 0x1fff, [BitConverter]::GetBytes([int]1), 4)
  "setup=0x{0:X8}" -f $t::WHvSetupPartition($p)
  "partition ready in {0:N1} ms" -f $sw.Elapsed.TotalMilliseconds
  "map=0x{0:X8}" -f $t::WHvMapGpaRange($p, $mem, [UInt64]0xFF000, [UInt64]4096, 7)
  "vp=0x{0:X8}" -f $t::WHvCreateVirtualProcessor($p, 0, 0)
  $ctx = New-Object byte[] 256
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $hr = $t::WHvRunVirtualProcessor($p, 0, $ctx, 256)
  $s = $sw.Elapsed.TotalSeconds
  $reason = [BitConverter]::ToUInt32($ctx, 0)
  $instructions = 2.0 * $iterations + 2
  "run=0x{0:X8} exitReason={1} (2 = I/O port, i.e. reached the OUT after the loop)" -f $hr, $reason
  "{0:N0} guest instructions in {1:N3} s = {2:N2} billion/s  (admin: {3})" -f $instructions, $s, ($instructions / $s / 1e9), $admin
  $t::WHvDeleteVirtualProcessor($p, 0) | Out-Null
} finally {
  $null = $t::WHvDeletePartition($p)
  $t::VirtualFree($mem, [IntPtr]::Zero, 0x8000) | Out-Null
}
