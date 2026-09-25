# Build only in an isolated Linux CI runner/container. No host setup is needed.
# Output: guest disk/kernel, capability manifest, package provenance, SHA256SUMS.
ARG ALPINE_VERSION=3.21
FROM alpine:${ALPINE_VERSION} AS guest
RUN apk add --no-cache \
      linux-virt mkinitfs eudev seatd \
      weston weston-backend-drm weston-backend-headless \
      weston-shell-desktop weston-terminal weston-clients \
      font-dejavu && \
    mkdir -p /etc/xdg/weston /usr/local/sbin /usr/share/browser-linux /var/log
COPY inittab /etc/inittab
COPY browser-boot browser-weston browser-exchange verify-wayland /usr/local/sbin/
COPY weston.ini /etc/xdg/weston/weston.ini
RUN chmod 755 /usr/local/sbin/browser-boot /usr/local/sbin/browser-weston /usr/local/sbin/browser-exchange /usr/local/sbin/verify-wayland && \
    printf '%s\n' 'browser-linux-wayland' > /etc/hostname && \
    printf '%s\n' 'Local Linux Wayland proof. CPU rendering; guest GPU acceleration unavailable.' > /etc/motd && \
    apk info -v | sort > /usr/share/browser-linux/package-versions.txt && \
    kernel_version="$(ls /lib/modules)" && \
    test "$(printf '%s\n' "$kernel_version" | wc -l)" = 1 && \
    grep -q '^CONFIG_DRM_VIRTIO_GPU=m$' "/boot/config-$kernel_version" && \
    grep -q '^CONFIG_VIRTIO_INPUT=m$' "/boot/config-$kernel_version" && \
    grep -q '^CONFIG_NET_9P_VIRTIO=m$' "/boot/config-$kernel_version" && \
    grep -q '^CONFIG_9P_FS=m$' "/boot/config-$kernel_version" && \
    mkinitfs -F 'base virtio ext4' -o /boot/initramfs-virt "$kernel_version" && \
    weston --version && \
    test -f /usr/lib/libweston-14/drm-backend.so && \
    test -x /usr/bin/weston-terminal
RUN timeout 15 /usr/local/sbin/verify-wayland

FROM alpine:${ALPINE_VERSION} AS image
RUN apk add --no-cache e2fsprogs
COPY --from=guest / /rootfs/
ARG ROOTFS_MIB=512
RUN mkdir /out && \
    cp /rootfs/boot/vmlinuz-virt /out/vmlinuz-virt && \
    cp /rootfs/boot/initramfs-virt /out/initramfs-virt && \
    cp /rootfs/usr/share/browser-linux/package-versions.txt /out/package-versions.txt && \
    cp /rootfs/lib/apk/db/installed /out/apk-installed.txt && \
    cp /rootfs/etc/apk/repositories /out/apk-repositories.txt && \
    printf '%s\n' '{"schema":1,"exchange":"virtio-9p","shutdown":"pid1-control-file","renderer":"pixman","architecture":"x86_64"}' > /out/guest-capabilities.json && \
    du -sh /rootfs && \
    truncate -s "${ROOTFS_MIB}M" /out/rootfs.img && \
    mkfs.ext4 -F -L browser-linux -O '^has_journal' -d /rootfs /out/rootfs.img && \
    e2fsck -fn /out/rootfs.img && \
    gzip -9 -n -c /out/rootfs.img > /out/rootfs.img.gz && \
    cd /out && sha256sum rootfs.img rootfs.img.gz vmlinuz-virt initramfs-virt package-versions.txt apk-installed.txt apk-repositories.txt guest-capabilities.json > SHA256SUMS

FROM scratch
COPY --from=image /out/ /
