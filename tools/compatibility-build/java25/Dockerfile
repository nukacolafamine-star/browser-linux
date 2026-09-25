# Optional runtime pack built on isolated Linux CI, not the default guest image.
FROM alpine:3.21 AS build
RUN apk add --no-cache binutils ca-certificates curl libstdc++ zlib
ARG JAVA_URL=https://corretto.aws/downloads/resources/25.0.4.8.1/amazon-corretto-25.0.4.8.1-alpine-linux-x64.tar.gz
ARG JAVA_SHA256=23281295fc2ca0a34764ca8a7b8a3db26f870aa7261999e18812c1f1de73e82d
RUN curl --fail --location "$JAVA_URL" -o /tmp/jdk.tar.gz && \
    printf '%s  %s\n' "$JAVA_SHA256" /tmp/jdk.tar.gz | sha256sum -c - && \
    mkdir /opt/jdk /out && tar -xzf /tmp/jdk.tar.gz --strip-components=1 -C /opt/jdk && \
    /opt/jdk/bin/java -version && \
    /opt/jdk/bin/jlink --add-modules java.base --strip-debug --no-header-files --no-man-pages --compress=zip-6 --output /out/java25 && \
    printf '%s\n%s\n' "$JAVA_URL" "$JAVA_SHA256" > /out/java25-source.txt
COPY Java25Smoke.java /tmp/Java25Smoke.java
RUN mkdir /out/proof && /opt/jdk/bin/javac -d /out/proof /tmp/Java25Smoke.java && \
    /opt/jdk/bin/jar --create --file /out/proof/java25-smoke.jar --main-class Java25Smoke -C /out/proof Java25Smoke.class && \
    timeout 30 /out/java25/bin/java -Xms16m -Xmx96m -XX:+UseSerialGC -jar /out/proof/java25-smoke.jar /tmp/java-proof.bin && \
    du -sh /out/java25 && \
    tar -czf /out/java25-smoke.tar.gz -C /out java25 proof java25-source.txt && \
    test "$(wc -c < /out/java25-smoke.tar.gz)" -le 67108864 && \
    cd /out && sha256sum java25-smoke.tar.gz > SHA256SUMS
FROM scratch
COPY --from=build /out/java25-smoke.tar.gz /out/java25-source.txt /out/SHA256SUMS /
