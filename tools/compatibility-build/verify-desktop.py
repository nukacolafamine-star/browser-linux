#!/usr/bin/env python3
"""Validate the Debian desktop guest on isolated CI with native QEMU TCG.

The disk is rebuilt from its published chunks, so this also checks the chunk
format the browser uses. This is guest validation, not browser acceptance.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("artifact", type=Path)
parser.add_argument("--startup-timeout", type=int, default=300)
parser.add_argument("--launcher", action="store_true", help="Also install and open the official Minecraft Launcher (needs Internet)")
parser.add_argument("--launcher-timeout", type=int, default=900)
args = parser.parse_args()
artifact = args.artifact.resolve()
proof = artifact / "native-proof"
proof.mkdir(exist_ok=True)
exchange = proof / "exchange"
exchange.mkdir(exist_ok=True)
(exchange / "incoming.txt").write_text("native exchange input\n", encoding="utf-8")
sock_path = proof / "qmp.sock"
report = {"scope": "Native QEMU TCG on isolated CI; not browser acceptance", "passed": False, "checks": []}
serial_chunks = []
process = qmp = qmp_file = None
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
            raise RuntimeError(f"Guest reported a graphics failure while waiting for {description}")
        time.sleep(0.1)
    raise TimeoutError(f"Timed out waiting for {description}")


def run(command_text, marker, timeout=60):
    """Runs a command in the serial root shell; returns its output up to the marker."""
    offset = len(serial())
    process.stdin.write((command_text + f"; printf '\\n{marker}_%s\\n' DONE\n").encode())
    process.stdin.flush()
    wait_for(lambda: f"{marker}_DONE" in serial()[offset:], timeout, marker)
    return serial()[offset:]


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
    mapping = {" ": ["spc"], "/": ["slash"], ".": ["dot"], ">": ["shift", "dot"], "\n": ["ret"], "-": ["minus"]}
    for char in text:
        keys = mapping.get(char, [char])
        command("send-key", {"keys": [{"type": "qcode", "data": key} for key in keys], "hold-time": 30})
        time.sleep(0.05)


def screendump(name):
    path = proof / name
    command("screendump", {"filename": str(path)})
    data = path.read_bytes()
    header = re.match(rb"P6\s+(\d+)\s+(\d+)\s+255\s", data)
    assert header, "Expected binary PPM framebuffer"
    pixels = data[header.end():]
    return {"width": int(header[1]), "height": int(header[2]), "distinctByteValues": len(set(pixels)),
            "sha256": hashlib.sha256(data).hexdigest()}


def rebuild_disk():
    manifest = json.loads((artifact / "disk" / "disk.json").read_text())
    image = proof / "disk.img"
    with open(image, "wb") as target:
        target.truncate(manifest["size"])
        for index, digest, size in manifest["chunks"]:
            blob = (artifact / "disk" / "chunks" / f"{digest}.gz").read_bytes()
            assert len(blob) == size, f"chunk {index} size"
            chunk = gzip.decompress(blob)
            assert len(chunk) == manifest["chunkSize"] and hashlib.sha256(chunk).hexdigest() == digest, f"chunk {index} hash"
            target.seek(index * manifest["chunkSize"])
            target.write(chunk)
    report["disk"] = {"sizeBytes": manifest["size"], "chunks": len(manifest["chunks"]),
                      "downloadBytesIfAllRead": sum(entry[2] for entry in manifest["chunks"])}
    return image


USER_ENV = "runuser -u user -- env HOME=/home/user XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DISPLAY=:0"

try:
    image = rebuild_disk()
    report["checks"].append("Published chunks verified by SHA-256 and reassembled into the disk image")
    argv = ["qemu-system-x86_64", "-M", "pc,i8042=off", "-cpu", "Westmere", "-m", "2048M", "-smp", "2",
            "-accel", "tcg,thread=multi", "-nodefaults", "-no-reboot",
            "-kernel", str(artifact / "bzImage"),
            "-append", "console=ttyS0 root=/dev/vda rw rootfstype=ext4 quiet loglevel=3",
            "-drive", f"id=root,file={image},format=raw,if=none", "-device", "virtio-blk-pci,drive=root",
            "-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0",
            "-vga", "none", "-device", "virtio-vga,xres=1280,yres=720", "-display", "none",
            "-serial", "stdio", "-monitor", "none", "-parallel", "none",
            "-device", "virtio-keyboard-pci", "-device", "virtio-tablet-pci",
            "-object", "rng-random,id=rng,filename=/dev/urandom", "-device", "virtio-rng-pci,rng=rng",
            "-virtfs", f"local,path={exchange},mount_tag=browser,security_model=none,id=browser",
            "-qmp", f"unix:{sock_path},server=on,wait=off"]
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
    qmp.settimeout(30)
    qmp.connect(str(sock_path))
    qmp_file = qmp.makefile("rwb")
    report["qemu"] = json.loads(qmp_file.readline()).get("QMP", {}).get("version")
    command("qmp_capabilities")

    wait_for(lambda: "BROWSER_LINUX_SERIAL_READY" in serial(), args.startup_timeout, "serial login shell")
    report["serialSeconds"] = round(time.monotonic() - started, 3)
    wait_for(lambda: "BROWSER_LINUX_WAYLAND_CLIENT_STARTED" in serial(), args.startup_timeout, "Weston and terminal")
    report["desktopSeconds"] = round(time.monotonic() - started, 3)
    for marker in ["BROWSER_LINUX_GUEST_BOOT arch=x86_64", "distro=debian-13", "BROWSER_LINUX_NETWORK_READY",
                   "BROWSER_LINUX_WAYLAND_READY", "BROWSER_LINUX_XWAYLAND_READY"]:
        assert marker in serial(), f"missing boot marker {marker}"
    report["checks"].append("Debian 13 booted the custom kernel; network, Weston, Xwayland socket and terminal started")

    output = run("uname -a; ls -l /dev/dri; pgrep -a -u user; cat /proc/cmdline", "SYSTEM")
    assert "x86_64" in output and "card0" in output and "weston" in output and "foot" in output, output
    output = run("cat /home/user/.local/state/weston.log", "WESTONLOG")
    assert re.search(r"[Pp]ixman", output), "Weston did not report the Pixman renderer"
    report["checks"].append("Serial shell saw DRM, Weston (Pixman), the terminal and seat processes")

    output = run("getent hosts deb.debian.org; curl -sS -o /dev/null -w 'HTTP=%{http_code}\\n' https://deb.debian.org/debian/dists/trixie/Release", "NET", 120)
    assert "HTTP=200" in output, f"HTTPS through guest DNS failed: {output}"
    output = run("apt-get update 2>&1 | tail -n 3", "APT", 300)
    assert re.search(r"Reading package lists|All packages are up to date|packages can be upgraded", output), output
    report["checks"].append("Guest DNS, HTTPS and apt package indexes worked through its virtual network card")

    output = run(f"{USER_ENV} xdpyinfo | head -n 12; pgrep -a Xwayland", "XWAYLAND", 120)
    assert "name of display" in output and "Xwayland" in output, output
    output = run(f"{USER_ENV} glxinfo -B", "GLXINFO", 120)
    renderer = re.search(r"OpenGL renderer string: (.+)", output)
    version = re.search(r"OpenGL version string: (.+)", output)
    core = re.search(r"OpenGL core profile version string: (.+)", output)
    assert renderer and version, output
    report["openGL"] = {"renderer": renderer[1].strip(), "version": version[1].strip(), "core": core[1].strip() if core else None}
    report["checks"].append(f"Xwayland served an X11 client and Mesa OpenGL ran: {report['openGL']['renderer']}")

    report["framebuffer"] = screendump("desktop.ppm")
    assert report["framebuffer"]["distinctByteValues"] > 8, "framebuffer looks blank"
    type_graphical("echo graphicsproof > /tmp/graphicsproof\n")
    time.sleep(2)
    output = run("cat /tmp/graphicsproof; stat -c %U /tmp/graphicsproof", "GRAPHICAL")
    assert "graphicsproof" in output and "user" in output, "graphical keyboard input did not reach the terminal"
    screendump("desktop-after-input.ppm")
    report["checks"].append("Virtual keyboard input typed a command into the Wayland terminal, verified via serial")

    wait_for(lambda: "BROWSER_LINUX_EXCHANGE_READY" in serial(), 30, "file exchange")
    output = run("cat /mnt/browser/incoming.txt; printf 'guest exchange output\\n' > /mnt/browser/outgoing.txt", "EXCHANGE")
    assert "native exchange input" in output
    wait_for(lambda: (exchange / "outgoing.txt").exists() and (exchange / "outgoing.txt").read_bytes() == b"guest exchange output\n", 10, "exchange write")
    report["checks"].append("Virtio 9P file exchange worked in both directions")

    if args.launcher:
        launcher = {"requested": True}
        report["launcher"] = launcher
        try:
            launch_started = time.monotonic()
            run(f"({USER_ENV} setsid /usr/local/bin/minecraft-launcher > /tmp/minecraft-launcher.log 2>&1 < /dev/null &)", "LAUNCH")
            wait_for(lambda: "Installed to" in run("cat /tmp/minecraft-launcher.log", "INSTALLLOG"), 300, "launcher download")
            launcher["installSeconds"] = round(time.monotonic() - launch_started, 3)
            deadline = time.monotonic() + args.launcher_timeout
            windows = ""
            window_pattern = re.compile(r'"[^"]*":\s*\("[^"]*(?:Minecraft|Launcher)[^"]*"[^)]*\)\s+(\d+)x(\d+)', re.I)
            while time.monotonic() < deadline:
                windows = run(f"{USER_ENV} xwininfo -root -tree | grep -i -E 'minecraft|launcher' | head -n 8", "WINDOWS", 60)
                sizes = [(int(w), int(h)) for w, h in window_pattern.findall(windows)]
                if sizes and not launcher.get("firstWindowSeconds"):
                    launcher["firstWindowSeconds"] = round(time.monotonic() - launch_started, 3)
                    launcher["updaterScreen"] = screendump("launcher-updater.ppm")
                # The bootstrap shows a small updater first; the launcher itself is a large window.
                if any(w >= 600 and h >= 400 for w, h in sizes):
                    launcher["opened"] = True
                    break
                if launcher.get("firstWindowSeconds") and "LAUNCHER_ALIVE" not in run(
                        "pgrep -u user -f 'minecraft-launcher' > /dev/null && echo LAUNCHER_ALIVE", "ALIVE"):
                    launcher["exited"] = True
                    break
                time.sleep(15)
            launcher["windows"] = windows
            launcher["windowSeconds"] = round(time.monotonic() - launch_started, 3)
            time.sleep(20)  # let the web view paint before the screenshot
            launcher["screen"] = screendump("launcher.ppm")
            launcher["log"] = run("tail -n 40 /tmp/minecraft-launcher.log; ls -la /home/user/.minecraft /home/user/.minecraft/launcher 2>&1 | head -n 40; tail -n 30 /home/user/.minecraft/launcher_log.txt 2>/dev/null", "LAUNCHLOG")[-8000:]
            missing = run("for f in /home/user/.minecraft/launcher/minecraft-launcher /home/user/.minecraft/launcher/*.so; do "
                          "ldd \"$f\" 2>/dev/null | grep 'not found' | sed \"s|^|$(basename $f): |\"; done", "LDD", 120)
            launcher["missingLibraries"] = sorted(set(re.findall(r"^\S+: \s*(\S+) => not found", missing, re.M)))
            launcher["opened"] = launcher.get("opened", False)
            if launcher.get("firstWindowSeconds"):
                report["checks"].append(f"Official Minecraft Launcher bootstrap downloaded from Mojang and opened its updater in {launcher['firstWindowSeconds']}s")
            if launcher["opened"]:
                report["checks"].append(f"The Minecraft Launcher's main window opened in {launcher['windowSeconds']}s")
        except Exception as error:
            launcher["error"] = str(error)

    (exchange / ".control" / "shutdown").write_text("request\n", encoding="utf-8")
    process.wait(timeout=90)
    reader.join(timeout=1)
    assert process.returncode == 0, f"Unclean QEMU exit: {process.returncode}"
    assert "BROWSER_LINUX_SHUTDOWN_REQUESTED" in serial() and "BROWSER_LINUX_STOPPED" in serial()
    report["checks"].append("Control-file request shut the guest down cleanly")
    report["passed"] = True
except Exception as error:
    report["error"] = str(error)
    raise
finally:
    if process is not None and process.poll() is None:
        try:
            process.stdin.write(b"cat /var/log/browser-desktop.log /var/log/browser-session.log /var/log/seatd.log /home/user/.local/state/weston.log 2>/dev/null\n")
            process.stdin.flush()
            time.sleep(1)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    for handle in (qmp_file, qmp):
        if handle is not None:
            handle.close()
    if sock_path.exists():
        sock_path.unlink()
    disk = proof / "disk.img"
    if disk.exists():
        disk.unlink()
    for ppm in proof.glob("*.ppm"):
        try:
            subprocess.run(["convert", str(ppm), str(ppm.with_suffix(".png"))], check=True, capture_output=True)
            ppm.unlink()
        except Exception:
            pass
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    (proof / "serial.log").write_text(serial(), encoding="utf-8")
    (proof / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2), flush=True)
