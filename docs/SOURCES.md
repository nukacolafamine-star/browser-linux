# Source downloads

The [Browser Linux repository](https://github.com/nukacolafamine-star/browser-linux) contains the browser application, guest bridge, runtime modifications, build tools and pinned dependency manifests. The [v0.1.0 release](https://github.com/nukacolafamine-star/browser-linux/releases/tag/v0.1.0) supplies the larger upstream source bundle alongside the application source.

Download [browser-linux-sources-0.1.0.tar](https://github.com/nukacolafamine-star/browser-linux/releases/download/v0.1.0/browser-linux-sources-0.1.0.tar) (275,240,960 bytes; approximately 262.5 MiB).

SHA-256:

```text
9606fbd908ed4d362a025d2da72fa27c0181d985cceaa4a00eb0828e8c127b58
```

The archive contains:

- Complete unchanged official release archives for Linux 6.4.16, BusyBox 1.36.1, musl 1.2.5 and LLVM 18.1.2.
- The Linux/Wasm port source, patches, configurations and build recipes from `719cd8d974dc37181204eb2db1d9b96dad260c9a`.
- Browser Linux guest-bridge source, init configuration, runtime additions and repackaging tools. The repository remains the canonical source for the complete current application.
- Original component license notices, source URLs, SHA-256 manifests, and downloaded publisher checksum/signature material.

The Linux and BusyBox downloads match their publisher SHA-256 checksum files. All 15 patches in the kernel, BusyBox, musl and LLVM patch directories were successfully applied to files from those pristine source archives. The compatibility patch for generated kernel headers is included; its application requires a kernel build and was not tested here. Downloaded signatures were not independently verified with a trusted key.

The kernel's runtime identifier `6.4.16-00012-gf3e782cb608b` matches the final archived kernel patch commit. Linux and BusyBox were not rebuilt from C during prototype development, and byte-for-byte reproduction of the upstream binaries has not been established. BusyBox/musl provenance follows the pinned upstream recipe. See [upstream provenance and rebuilding](UPSTREAM.md) and the source bundle's manifest for the precise evidence and limitations.

The source bundle is a separate release download. It is not part of the page's initial download or offline cache. Running the browser application does not install any of these source packages or build tools on the host operating system.
