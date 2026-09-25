# Built only in an isolated Linux CI runner. Nothing is installed on the
# user's computer. Output: a Linux kernel with the browser machine's virtual
# devices built in, and a Debian 13 desktop disk published as lazily loaded
# chunks (see ../chunk-image.py), plus package and checksum provenance.
ARG DEBIAN_IMAGE=debian:trixie
ARG LINUX_VERSION=6.18.54
ARG LINUX_SHA256=9df30b02dd8102bbd0be52556288ef6889ddbe7f1ddb96fbf847d0becf3eacac

FROM ${DEBIAN_IMAGE} AS kernel
ARG LINUX_VERSION
ARG LINUX_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential bc bison flex libelf-dev libssl-dev cpio xz-utils ca-certificates curl python3 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSLo linux.tar.xz "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${LINUX_VERSION}.tar.xz" && \
    echo "${LINUX_SHA256}  linux.tar.xz" | sha256sum -c - && \
    tar -xf linux.tar.xz && mv "linux-${LINUX_VERSION}" linux && rm linux.tar.xz
COPY desktop/kernel.config /build/browser.config
RUN cd linux && make x86_64_defconfig kvm_guest.config && \
    scripts/kconfig/merge_config.sh -m .config /build/browser.config && \
    make olddefconfig && \
    missing=0 && while IFS= read -r line; do \
      case "$line" in CONFIG_*=*) grep -qx "$line" .config || { echo "kernel option not applied: $line"; missing=1; } ;; esac; \
    done < /build/browser.config && test "$missing" = 0 && \
    make -j"$(nproc)" bzImage && \
    mkdir /out && cp arch/x86/boot/bzImage /out/bzImage && cp .config /out/kernel.config && \
    make -s kernelrelease > /out/kernel-release.txt

# The launcher's certificate shortcut (see fast-ca.c), built for the guest.
FROM ${DEBIAN_IMAGE} AS fastca
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY desktop/fast-ca.c /src/fast-ca.c
RUN mkdir /out && gcc -O2 -Wall -Werror -shared -fPIC -o /out/libbrowser-linux-fast-ca.so /src/fast-ca.c -ldl

FROM ${DEBIAN_IMAGE} AS rootfs
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      sysvinit-core sysvinit-utils udev kmod dbus dbus-bin seatd \
      weston xwayland foot \
      libgl1-mesa-dri libegl-mesa0 libglx-mesa0 libgl1 libopengl0 libegl1 libgles2 mesa-utils mesa-vulkan-drivers \
      fonts-dejavu-core fontconfig adwaita-icon-theme hicolor-icon-theme gsettings-desktop-schemas \
      ca-certificates curl wget iproute2 iputils-ping netbase \
      procps psmisc less nano sudo file xz-utils unzip zip bzip2 python3 \
      x11-xserver-utils x11-utils xauth \
      libgtk-3-0t64 libnss3 libnspr4 libgbm1 libasound2t64 libxss1 libxtst6 libsecret-1-0 libcups2t64 \
      libatk-bridge2.0-0t64 libatk1.0-0t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
      libxfixes3 libpango-1.0-0 libcairo2 libgpg-error0 zlib1g libcurl4t64 libxshmfence1 libx11-xcb1 \
      libxcb-dri3-0 libuuid1 libexpat1 libglib2.0-0t64 libdbus-1-3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN for group in sudo video input render audio tty; do getent group "$group" > /dev/null || groupadd -r "$group"; done && \
    useradd -m -u 1000 -s /bin/bash -G sudo,video,input,render,audio,tty user && \
    passwd -l root && \
    printf 'browser-linux\n' > /etc/hostname && \
    : > /etc/machine-id && mkdir -p /var/lib/dbus && rm -f /var/lib/dbus/machine-id && ln -s /etc/machine-id /var/lib/dbus/machine-id
COPY desktop/rootfs/ /
COPY --from=fastca /out/libbrowser-linux-fast-ca.so /usr/local/lib/browser-linux/
COPY desktop/make-icon.py /tmp/make-icon.py
RUN chmod 755 /usr/local/sbin/browser-boot /usr/local/sbin/browser-desktop /usr/local/sbin/browser-exchange \
      /usr/local/sbin/browser-halt /usr/local/bin/browser-session /usr/local/bin/browser-welcome \
      /usr/local/bin/minecraft-launcher && \
    chmod 440 /etc/sudoers.d/browser-linux && visudo -cf /etc/sudoers.d/browser-linux && \
    cp /usr/share/ca-certificates/mozilla/ISRG_Root_X1.crt /etc/ssl/browser-linux-ca.pem && \
    test -s /etc/ssl/browser-linux-ca.pem && test -e /etc/ssl/certs/ca-certificates.crt && \
    LD_PRELOAD=/usr/local/lib/browser-linux/libbrowser-linux-fast-ca.so curl --version > /dev/null && \
    mkdir -p /usr/share/icons/browser-linux && python3 /tmp/make-icon.py /usr/share/icons/browser-linux/minecraft-launcher.png && \
    rm /tmp/make-icon.py && \
    test -f /usr/share/weston/terminal.png && \
    test -x /usr/bin/weston && test -x /usr/bin/Xwayland && test -x /usr/bin/foot && \
    find /usr/lib -path '*weston*' -name xwayland.so | grep -q . && \
    find /usr/lib -path '*weston*' -name drm-backend.so | grep -q . && \
    find /usr/lib -path '*weston*' -name desktop-shell.so | grep -q . && \
    test -x /usr/lib/systemd/systemd-udevd && test -x /sbin/agetty && \
    for tool in dbus-run-session dbus-uuidgen dbus-daemon seatd runuser pgrep udevadm glxinfo xdpyinfo xwininfo curl mkswap swapon; do \
      command -v "$tool" > /dev/null || { echo "missing $tool"; exit 1; }; \
    done && \
    weston --version

FROM ${DEBIAN_IMAGE} AS image
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs python3 && rm -rf /var/lib/apt/lists/*
COPY --from=rootfs / /rootfs/
COPY --from=kernel /out/ /out/
COPY chunk-image.py /usr/local/bin/chunk-image.py
ARG DISK_GIB=16
RUN rm -f /rootfs/.dockerenv && \
    dpkg-query --admindir=/rootfs/var/lib/dpkg -W -f='${Package} ${Version} ${Architecture}\n' | sort > /out/packages.txt && \
    cp /rootfs/etc/apt/sources.list.d/debian.sources /out/apt-sources.txt && \
    printf '{"schema":2,"architecture":"x86_64","distribution":"debian-13","kernel":"%s","disk":"chunked-nbd","exchange":"virtio-9p","shutdown":"pid1-control-file","network":"static-10.0.2.15","xwayland":true,"renderers":["pixman","gl"]}\n' \
      "$(cat /out/kernel-release.txt)" > /out/guest-capabilities.json && \
    truncate -s "${DISK_GIB}G" /tmp/disk.img && \
    mkfs.ext4 -F -q -L browser-linux -m 1 -E lazy_itable_init=0,lazy_journal_init=0 -d /rootfs /tmp/disk.img && \
    e2fsck -fn /tmp/disk.img && \
    python3 /usr/local/bin/chunk-image.py /tmp/disk.img /out/disk | tee /out/disk-stats.json && \
    rm /tmp/disk.img && \
    cd /out && sha256sum bzImage kernel.config kernel-release.txt packages.txt apt-sources.txt guest-capabilities.json disk/disk.json > SHA256SUMS

FROM scratch
COPY --from=image /out/ /
