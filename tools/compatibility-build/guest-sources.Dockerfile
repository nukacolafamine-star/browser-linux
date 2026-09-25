# Separate source collection only. No emulator or guest binary is published.
# generated/source-input must contain files exported by the EXACT guest build.
FROM alpine:3.21 AS source-collection
RUN apk add --no-cache abuild git python3 xz zstd curl
COPY generated/source-input/ /input/
COPY collect-guest-sources.py /collector.py
RUN python3 /collector.py /input/apk-installed.txt /input/package-versions.txt /out

FROM scratch
COPY --from=source-collection /out/ /
