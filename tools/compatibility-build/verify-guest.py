#!/usr/bin/env python3
"""Validate the guest on isolated CI using native QEMU TCG, never KVM.

This proves guest setup independently of Wasm. It is not browser acceptance.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import socket
import subprocess
import tarfile
import threading
import time


parser = argparse.ArgumentParser()
parser.add_argument("artifact", type=Path)
parser.add_argument("--startup-timeout", type=int, default=90)
parser.add_argument("--java-pack", type=Path, help="Optional CI-built Java25 pack; never modifies the default guest image")
args = parser.parse_args()
artifact = args.artifact.resolve()
proof = artifact / "native-proof"
proof.mkdir(exist_ok=True)
exchange = proof / "exchange"
exchange.mkdir(exist_ok=True)
(exchange / "incoming.txt").write_text("native exchange input\n", encoding="utf-8")
if args.java_pack:
    with tarfile.open(args.java_pack, "r:gz") as archive:
        archive.extractall(exchange, filter="data")
sock_path = proof / "qmp.sock"
report = {"scope": "Native QEMU TCG on isolated CI; not browser acceptance", "passed": False, "checks": []}
serial_chunks = []
process = None
qmp = None
qmp_file = None
counter = 0
started = time.monotonic()


def serial():
    return b"".join(serial_chunks).decode("utf-8", "replace")


def wait_for(predicate, timeout, description):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        if process.poll() is not None:
            raise RuntimeError(f"QEMU exited {process.returncode} while waiting for {description}")
        if "BROWSER_LINUX_GRAPHICS_FAILED" in serial():
            raise RuntimeError(f"Guest reported a graphics startup failure while waiting for {description}")
        time.sleep(0.05)
    raise TimeoutError(f"Timed out waiting for {description}")


def serial_command(command):
    process.stdin.write((command + "\n").encode())
    process.stdin.flush()


def command(name, arguments=None):
    global counter
    counter += 1
    message = {"execute": name, "id": counter}
    if arguments is not None:
        message["arguments"] = arguments
    qmp_file.write(json.dumps(message).encode() + b"\n")
    qmp_file.flush()
    while True:
        response = json.loads(qmp_file.readline())
        if response.get("id") != counter:
            continue
        if "error" in response:
            raise RuntimeError(f"QMP {name}: {response['error']}")
        return response.get("return")


def type_graphical(text):
    mapping = {" ": ["spc"], "/": ["slash"], ".": ["dot"], ">": ["shift", "dot"], "\n": ["ret"]}
    for char in text:
        keys = mapping.get(char, [char])
        assert all(key in mapping.get(char, []) or key.isalnum() for key in keys)
        command("send-key", {"keys": [{"type": "qcode", "data": key} for key in keys], "hold-time": 30})
        time.sleep(0.05)


try:
    # Snapshot mode keeps the built artifact's disk bytes unchanged.
    argv = ["qemu-system-x86_64", "-M", "pc", "-m", "512M", "-smp", "1", "-accel", "tcg,thread=single",
            "-kernel", str(artifact / "vmlinuz-virt"), "-initrd", str(artifact / "initramfs-virt"),
            "-drive", f"file={artifact / 'rootfs.img'},if=virtio,format=raw,snapshot=on",
            "-append", "console=ttyS0,115200 root=/dev/vda rootfstype=ext4 rw",
            "-vga", "none", "-device", "virtio-vga", "-display", "none", "-serial", "stdio", "-monitor", "none",
            # Native CI is unprivileged; ignore host chown failures. Browser
            # MEMFS uses passthrough because its ownership is virtual in-tab.
            "-virtfs", f"local,path={exchange},mount_tag=browser,security_model=none,id=browser",
            "-qmp", f"unix:{sock_path},server=on,wait=off", "-nic", "none", "-no-reboot"]
    report["arguments"] = argv
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def consume():
        while chunk := process.stdout.read1(4096):
            serial_chunks.append(chunk)
            print(chunk.decode("utf-8", "replace"), end="", flush=True)

    reader = threading.Thread(target=consume, daemon=True)
    reader.start()
    wait_for(lambda: sock_path.exists(), 10, "QMP socket")
    qmp = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    qmp.settimeout(10)
    qmp.connect(str(sock_path))
    qmp_file = qmp.makefile("rwb")
    greeting = json.loads(qmp_file.readline())
    report["qemu"] = greeting.get("QMP", {}).get("version")
    command("qmp_capabilities")
    wait_for(lambda: "BROWSER_LINUX_WAYLAND_CLIENT_STARTED" in serial(), args.startup_timeout,
             "real guest Weston and graphical terminal")
    report["startupSeconds"] = round(time.monotonic() - started, 3)
    report["checks"].append("Real guest kernel booted; Weston socket and terminal processes started")

    serial_command("printf 'GUEST_%s\\n' SERIAL_OK; uname -a; ps; ls -l /dev/dri /run/user/0; cat /var/log/weston.log")
    wait_for(lambda: "GUEST_SERIAL_OK" in serial(), 10, "serial shell command")
    wait_for(lambda: re.search(r"(Pixman|pixman) renderer", serial()) is not None, 10, "Pixman renderer log")
    report["checks"].append("Independent serial shell verified DRM, processes, socket and Pixman renderer log")
    time.sleep(1)
    screenshot = proof / "weston.ppm"
    command("screendump", {"filename": str(screenshot)})
    data = screenshot.read_bytes()
    header = re.match(rb"P6\s+(\d+)\s+(\d+)\s+255\s", data)
    assert header, "Expected binary PPM framebuffer"
    pixels = data[header.end():]
    assert len(set(pixels)) > 8, "Framebuffer looks blank"
    report["framebuffer"] = {"width": int(header[1]), "height": int(header[2]), "bytes": len(pixels),
                             "sha256": hashlib.sha256(data).hexdigest(), "distinctByteValues": len(set(pixels))}
    report["checks"].append("Nonblank Weston framebuffer captured through QMP")

    type_graphical("echo graphicsproof > /tmp/graphicsproof\n")
    time.sleep(1)
    serial_command("if test \"$(cat /tmp/graphicsproof 2>/dev/null)\" = graphicsproof; then printf 'GUEST_%s\\n' GRAPHICAL_INPUT_OK; fi")
    wait_for(lambda: "GUEST_GRAPHICAL_INPUT_OK" in serial(), 10, "graphical keyboard command verified through serial")
    report["checks"].append("Keyboard input through virtual hardware executed in graphical terminal; serial read its file")
    command("screendump", {"filename": str(proof / "weston-after-input.ppm")})

    wait_for(lambda: "BROWSER_LINUX_EXCHANGE_READY" in serial(), 10, "optional in-tab file exchange mounted")
    serial_command("if test \"$(cat /mnt/browser/incoming.txt)\" = 'native exchange input'; then printf 'GUEST_%s\\n' EXCHANGE_READ_OK; fi; printf 'guest exchange output\\n' > /mnt/browser/outgoing.txt")
    wait_for(lambda: "GUEST_EXCHANGE_READ_OK" in serial(), 10, "guest reading the shared exchange")
    wait_for(lambda: (exchange / "outgoing.txt").exists() and
             (exchange / "outgoing.txt").read_bytes() == b"guest exchange output\n",
             10, "guest completing the shared exchange write")
    report["checks"].append("Virtio 9P exchange verified in both directions with an isolated CI directory")
    if args.java_pack:
        java_results = []
        expected = bytes((i * 31 + 7) & 255 for i in range(65536))
        for label, mode in [("INT", "-Xint"), ("JIT", "-Xbatch -XX:+PrintCompilation")]:
            offset = len(serial())
            java_started = time.monotonic()
            output_name = f"java-proof-{label}.bin"
            serial_command(f"timeout 90 /mnt/browser/java25/bin/java {mode} -Xms16m -Xmx96m "
                           "-XX:ReservedCodeCacheSize=32m -XX:MaxMetaspaceSize=64m -XX:+UseSerialGC "
                           "-XX:ActiveProcessorCount=1 -Xlog:gc -jar /mnt/browser/proof/java25-smoke.jar "
                           f"/mnt/browser/{output_name}; java_status=$?; printf 'JAVA_%s_EXIT=%s\\n' {label} \"$java_status\"")
            marker = rf"JAVA_{label}_EXIT=(\d+)"
            wait_for(lambda: re.search(marker, serial()[offset:]) is not None, 110, f"Java25 {label} guest process")
            output = serial()[offset:]
            assert re.search(marker, output)[1] == "0", f"Java25 {label} failed: {output}"
            assert "JAVA25_SMOKE_OK" in output, f"Java25 {label} did not complete its checks"
            assert "GC(" in output, f"Java25 {label} did not report a garbage collection"
            if label == "JIT":
                assert "Java25Smoke::hotSum" in output, "JIT did not report compiling the exercised method"
            assert (exchange / output_name).read_bytes() == expected, f"Java25 {label} file bytes differed"
            java_results.append({"mode": label, "elapsedSeconds": round(time.monotonic() - java_started, 3),
                                 "output": output, "fileSha256": hashlib.sha256(expected).hexdigest()})
        report["java25"] = {"packBytes": args.java_pack.stat().st_size, "runs": java_results}
        report["checks"].append("Java25 interpreter and JIT modes ran a JAR, threads, files and GC inside the real guest")
    (exchange / ".control" / "shutdown").write_text("request\n", encoding="utf-8")
    process.wait(timeout=20)
    reader.join(timeout=1)
    assert process.returncode == 0, f"Unclean QEMU exit: {process.returncode}"
    assert "BROWSER_LINUX_SHUTDOWN_REQUESTED" in serial(), "Guest did not acknowledge control request"
    assert not (exchange / ".control" / "shutdown").exists(), "Guest did not consume control request"
    report["checks"].append("Control-file request caused guest sync/shutdown and a clean QEMU exit")
    report["passed"] = True
except Exception as error:
    report["error"] = str(error)
    raise
finally:
    if process is not None and process.poll() is None:
        try:
            serial_command("cat /var/log/browser-weston.log /var/log/browser-exchange.log /var/log/seatd.log /var/log/weston.log /var/log/weston-terminal.log 2>/dev/null")
            time.sleep(0.5)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    if qmp_file is not None:
        qmp_file.close()
    if qmp is not None:
        qmp.close()
    if sock_path.exists():
        sock_path.unlink()
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    (proof / "serial.log").write_text(serial(), encoding="utf-8")
    (proof / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)
